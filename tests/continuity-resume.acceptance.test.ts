import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { FileKeyStore } from '../src/auth/key-store.js';
import { loadConfig } from '../src/config.js';
import { createHttpHandler } from '../src/http/app.js';
import { FileAuditLogger } from '../src/logging/audit-log.js';
import { createMcpHttpHandler } from '../src/mcp/handler.js';
import { createRuntimeServices, type RuntimeServices } from '../src/runtime/services.js';
import type { MemoryScope } from '../src/memory/types.js';

const roots: string[] = [];
const servers: Server[] = [];
const runtimes: RuntimeServices[] = [];

const scenarioFixture = JSON.parse(readFileSync(
  path.join(import.meta.dirname, 'fixtures', 'continuity', 'resume-scenarios.json'),
  'utf8',
)) as Array<{ id: string; name: string }>;

async function fixture(label: string) {
  const root = await mkdtemp(path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), `agent-core-continuity-acceptance-${label}-`));
  roots.push(root);
  const memory = loadConfig({}, root).memory;
  const memoryConfig = {
    ...memory,
    enabled: true,
    dbPath: path.join(root, 'runtime', 'memory', 'continuity-acceptance.sqlite'),
  };
  const runtime = createRuntimeServices([root], path.join(root, 'capabilities'), undefined, memoryConfig);
  runtimes.push(runtime);
  const keyStore = new FileKeyStore(path.join(root, 'data'));
  const principalA = await keyStore.create(`continuity-acceptance-a-${label}`);
  const principalB = await keyStore.create(`continuity-acceptance-b-${label}`);
  const app = createHttpHandler({
    keyStore,
    auditLogger: new FileAuditLogger(path.join(root, 'logs')),
    mcpHandler: createMcpHttpHandler(runtime),
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return {
    root,
    runtime,
    memoryConfig,
    principalA,
    principalB,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    scopeA: { principalId: principalA.metadata.id, projectId: root } satisfies MemoryScope,
  };
}

async function call(baseUrl: string, key: string, name: string, args: Record<string, unknown> = {}) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 91, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await response.json() as Record<string, any>;
  const text = String(raw.result.content[0].text);
  return { raw, result: JSON.parse(text) as Record<string, any> };
}

async function route(baseUrl: string, key: string, task: string, objective = task) {
  const routed = await call(baseUrl, key, 'capability_route', {
    task,
    continuity: { objective },
  });
  expect(routed.raw.result.isError).not.toBe(true);
  expect(routed.result.continuityStatus).toBe('healthy');
  return routed.result;
}

async function checkpoint(
  baseUrl: string,
  key: string,
  routeContextId: string,
  input: Record<string, unknown>,
) {
  const result = await call(baseUrl, key, 'task_checkpoint', { routeContextId, ...input });
  expect(result.raw.result.isError).not.toBe(true);
  return result.result;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(runtimes.splice(0).map(async (runtime) => {
    try { await runtime.memory.close(); } catch {}
  }));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('cross-session local continuity acceptance', () => {
  it('loads the seven required acceptance scenarios from the canonical fixture', () => {
    expect(scenarioFixture.map((scenario) => scenario.id)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
  });

  it('Scenario A: two completed tasks and one deferred task are rehydrated on a fresh route', async () => {
    const f = await fixture('a');
    const first = await route(f.baseUrl, f.principalA.key, 'Task One', 'Complete Task One');
    await checkpoint(f.baseUrl, f.principalA.key, first.routeContextId, {
      status: 'completed', summary: 'Task One completed.', projectTerminal: true,
    });
    const second = await route(f.baseUrl, f.principalA.key, 'Task Two', 'Complete Task Two');
    await checkpoint(f.baseUrl, f.principalA.key, second.routeContextId, {
      status: 'completed', summary: 'Task Two completed.', projectTerminal: true,
    });
    const third = await route(f.baseUrl, f.principalA.key, 'Task Three', 'Defer Task Three');
    await checkpoint(f.baseUrl, f.principalA.key, third.routeContextId, {
      status: 'deferred', summary: 'Task Three deferred for later.',
    });

    const fresh = await route(f.baseUrl, f.principalA.key, 'Inspect current project state', 'Inspect current project state');
    const snapshot = fresh.continuitySnapshot;
    expect(snapshot.recentCompleted.map((task: any) => task.taskId)).toEqual(expect.arrayContaining([
      first.continuityTaskId,
      second.continuityTaskId,
    ]));
    expect(snapshot.deferredTasks.map((task: any) => task.taskId)).toContain(third.continuityTaskId);
    expect(snapshot.recentCompleted.every((task: any) => task.status === 'completed')).toBe(true);
    expect(snapshot.deferredTasks.find((task: any) => task.taskId === third.continuityTaskId)?.status).toBe('deferred');
  });

  it('Scenario B: a terminal task with three next candidates preserves the same ordered frontier on a fresh route', async () => {
    const f = await fixture('b');
    const original = await route(f.baseUrl, f.principalA.key, 'Produce next frontier');
    const closed = await checkpoint(f.baseUrl, f.principalA.key, original.routeContextId, {
      status: 'completed',
      summary: 'Frontier source task completed.',
      nextCandidates: [
        { title: 'Third', rationale: 'lower priority', priority: 1 },
        { title: 'First', rationale: 'highest priority', priority: 3 },
        { title: 'Second', rationale: 'middle priority', priority: 2 },
      ],
    });
    expect(closed.frontier.map((item: any) => item.title)).toEqual(['First', 'Second', 'Third']);

    const fresh = await route(f.baseUrl, f.principalA.key, 'Open a fresh route after frontier creation');
    expect(fresh.continuitySnapshot.frontier.map((item: any) => item.title)).toEqual(['First', 'Second', 'Third']);
  });

  it('Scenario C: task IDs, checkpoint hash, and frontier survive a MemoryService/runtime restart', async () => {
    const f = await fixture('c');
    const original = await route(f.baseUrl, f.principalA.key, 'Persist continuity over restart');
    const closed = await checkpoint(f.baseUrl, f.principalA.key, original.routeContextId, {
      status: 'completed',
      summary: 'Persisted before restart.',
      nextCandidates: [
        { title: 'Resume A', rationale: 'first candidate', priority: 2 },
        { title: 'Resume B', rationale: 'second candidate', priority: 1 },
      ],
    });
    const before = await f.runtime.memory.getContinuitySnapshot(f.scopeA);
    const taskBefore = await f.runtime.memory.getContinuityTask(f.scopeA, original.continuityTaskId);
    expect(taskBefore?.lastCheckpointId).toBe(closed.checkpointId);

    await f.runtime.memory.close();
    const reopened = createRuntimeServices([f.root], path.join(f.root, 'capabilities'), undefined, f.memoryConfig);
    runtimes.push(reopened);
    const after = await reopened.memory.getContinuitySnapshot(f.scopeA);
    const taskAfter = await reopened.memory.getContinuityTask(f.scopeA, original.continuityTaskId);

    expect(taskAfter?.taskId).toBe(original.continuityTaskId);
    expect(taskAfter?.lastCheckpointId).toBe(closed.checkpointId);
    expect(after.frontier.map((item) => item.frontierId)).toEqual(before.frontier.map((item) => item.frontierId));
    expect(after.snapshotHash).toBe(before.snapshotHash);
  });

  it('Scenario D: a fresh continuation route converts the abandoned open turn to interrupted and resumes the same task, never completed', async () => {
    const f = await fixture('d');
    const original = await route(f.baseUrl, f.principalA.key, 'Long running continuity task');
    const before = await f.runtime.memory.getContinuityTask(f.scopeA, original.continuityTaskId);
    expect(before?.status).toBe('running');

    const resumed = await call(f.baseUrl, f.principalA.key, 'capability_route', { task: 'lanjutkan' });
    expect(resumed.raw.result.isError).not.toBe(true);
    expect(resumed.result.continuityTaskId).toBe(original.continuityTaskId);
    expect(resumed.result.continuityTurnId).not.toBe(original.continuityTurnId);

    const db = new DatabaseSync(f.runtime.memory.config.dbPath, { readOnly: true });
    try {
      const oldTurn = db.prepare('SELECT state FROM continuity_turns WHERE id = ?').get(original.continuityTurnId) as any;
      const newTurn = db.prepare('SELECT state FROM continuity_turns WHERE id = ?').get(resumed.result.continuityTurnId) as any;
      expect(oldTurn.state).toBe('interrupted');
      expect(newTurn.state).toBe('open');
    } finally {
      db.close();
    }
    const snapshot = await f.runtime.memory.getContinuitySnapshot(f.scopeA);
    expect(snapshot.interruptedTurns.map((turn) => turn.turnId)).toContain(original.continuityTurnId);
    expect(snapshot.recentCompleted.map((task) => task.taskId)).not.toContain(original.continuityTaskId);
    expect((await f.runtime.memory.getContinuityTask(f.scopeA, original.continuityTaskId))?.status).toBe('running');
  });

  it('Scenario E: two projects under the same principal never cross-contaminate', async () => {
    const f = await fixture('e');
    const projectA: MemoryScope = { principalId: f.principalA.metadata.id, projectId: `${f.root}\\project-a` };
    const projectB: MemoryScope = { principalId: f.principalA.metadata.id, projectId: `${f.root}\\project-b` };
    const a = await f.runtime.memory.beginContinuityTurn(projectA, 'route-project-a', 'Project A task', undefined, { objective: 'Project A objective' });
    const b = await f.runtime.memory.beginContinuityTurn(projectB, 'route-project-b', 'Project B task', undefined, { objective: 'Project B objective' });

    const snapA = await f.runtime.memory.getContinuitySnapshot(projectA);
    const snapB = await f.runtime.memory.getContinuitySnapshot(projectB);
    expect(snapA.activeTasks.map((task) => task.taskId)).toEqual([a.taskId]);
    expect(snapB.activeTasks.map((task) => task.taskId)).toEqual([b.taskId]);
    expect(snapA.currentObjective).toBe('Project A objective');
    expect(snapB.currentObjective).toBe('Project B objective');
  });

  it('Scenario F: two principals in the same project never cross-contaminate', async () => {
    const f = await fixture('f');
    const sharedProject = `${f.root}\\shared-project`;
    const scopeA: MemoryScope = { principalId: f.principalA.metadata.id, projectId: sharedProject };
    const scopeB: MemoryScope = { principalId: f.principalB.metadata.id, projectId: sharedProject };
    const a = await f.runtime.memory.beginContinuityTurn(scopeA, 'route-principal-a', 'Principal A task', undefined, { objective: 'Principal A objective' });
    const b = await f.runtime.memory.beginContinuityTurn(scopeB, 'route-principal-b', 'Principal B task', undefined, { objective: 'Principal B objective' });

    const snapA = await f.runtime.memory.getContinuitySnapshot(scopeA);
    const snapB = await f.runtime.memory.getContinuitySnapshot(scopeB);
    expect(snapA.activeTasks.map((task) => task.taskId)).toEqual([a.taskId]);
    expect(snapB.activeTasks.map((task) => task.taskId)).toEqual([b.taskId]);
    expect(await f.runtime.memory.getContinuityTask(scopeA, b.taskId)).toBeNull();
    expect(await f.runtime.memory.getContinuityTask(scopeB, a.taskId)).toBeNull();
  });

  it('Scenario G: old semantic chatter cannot displace or alter current continuity state/hash', async () => {
    const f = await fixture('g');
    const current = await f.runtime.memory.beginContinuityTurn(
      f.scopeA,
      'route-current-g',
      'Current task survives chatter',
      undefined,
      { objective: 'Current objective survives chatter' },
    );
    const before = await f.runtime.memory.getContinuitySnapshot(f.scopeA);

    for (let i = 0; i < 75; i += 1) {
      await f.runtime.memory.commit({
        scope: f.scopeA,
        canonicalKey: `old.chatter.${String(i).padStart(3, '0')}`,
        kind: 'observation',
        value: `Old semantic chatter ${i}: unrelated historical conversation that must not replace current task state.`,
        importance: 0.1,
        sourceType: 'acceptance_fixture',
      });
    }

    const after = await f.runtime.memory.getContinuitySnapshot(f.scopeA);
    expect(after.snapshotHash).toBe(before.snapshotHash);
    expect(after.currentObjective).toBe('Current objective survives chatter');
    expect(after.activeTasks.map((task) => task.taskId)).toEqual([current.taskId]);
  }, 10_000);
});
