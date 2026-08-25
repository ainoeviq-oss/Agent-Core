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

const roots: string[] = [];
const servers: Server[] = [];
const runtimes: RuntimeServices[] = [];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function fixture(label: string) {
  const root = await mkdtemp(path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), `agent-core-continuity-route-${label}-`));
  roots.push(root);
  const memory = loadConfig({}, root).memory;
  const runtime = createRuntimeServices([root], path.join(root, 'capabilities'), undefined, {
    ...memory,
    enabled: true,
    dbPath: path.join(root, 'runtime', 'memory', 'continuity-routing.sqlite'),
  });
  runtimes.push(runtime);
  const keyStore = new FileKeyStore(path.join(root, 'data'));
  const principal = await keyStore.create(`continuity-routing-${label}`);
  const app = createHttpHandler({
    keyStore,
    auditLogger: new FileAuditLogger(path.join(root, 'logs')),
    mcpHandler: createMcpHttpHandler(runtime),
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    root,
    runtime,
    principal,
    scope: { principalId: principal.metadata.id, projectId: root },
    baseUrl,
    dbPath: memory.dbPath.replace('agent-core-memory.sqlite', 'continuity-routing.sqlite'),
  };
}

async function call(baseUrl: string, key: string, args: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 71, method: 'tools/call', params: { name: 'capability_route', arguments: args } }),
  });
  const body = await response.json() as Record<string, any>;
  return {
    raw: body,
    result: JSON.parse(body.result.content[0].text) as Record<string, any>,
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.memory.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('capability_route local continuity integration', () => {
  it('persists redacted routed input before execution and binds task/turn/snapshot identity to the route context', async () => {
    const f = await fixture('capture');
    const secret = 'route-secret-123456789';
    const routed = await call(f.baseUrl, f.principal.key, {
      task: `Implement continuity routing. Authorization: Bearer ${secret}`,
      context: `Keep evidence local. token=${secret}`,
      continuity: {
        objective: 'Integrate continuity with capability_route',
        acceptanceCriteria: ['Persist task before execution', 'Return deterministic snapshot'],
        constraints: ['Do not leak credentials'],
      },
    });

    expect(routed.raw.result.isError).not.toBe(true);
    expect(routed.result.routeContextId).toMatch(UUID_RE);
    expect(routed.result.continuityStatus).toBe('healthy');
    expect(routed.result.continuityTurnId).toMatch(UUID_RE);
    expect(routed.result.continuityTaskId).toMatch(UUID_RE);
    expect(routed.result.continuitySnapshotHash).toMatch(/^[a-f0-9]{64}$/);
    expect(routed.result.continuitySnapshot.currentObjective).toBe('Integrate continuity with capability_route');
    expect(routed.result.continuitySnapshot.activeTasks.map((item: any) => item.taskId))
      .toContain(routed.result.continuityTaskId);

    const storedRoute = f.runtime.routes.get(routed.result.routeContextId)!;
    expect(storedRoute).toMatchObject({
      continuityTurnId: routed.result.continuityTurnId,
      continuityTaskId: routed.result.continuityTaskId,
      continuitySnapshotHash: routed.result.continuitySnapshotHash,
    });

    const db = new DatabaseSync(f.runtime.memory.config.dbPath, { readOnly: true });
    try {
      const turn = db.prepare(`SELECT route_context_id, task_id, input_text, context_text, state
        FROM continuity_turns WHERE id = ?`).get(routed.result.continuityTurnId) as Record<string, unknown>;
      expect(turn.route_context_id).toBe(routed.result.routeContextId);
      expect(turn.task_id).toBe(routed.result.continuityTaskId);
      expect(turn.state).toBe('open');
      expect(String(turn.input_text)).toContain('[REDACTED:BEARER]');
      expect(String(turn.input_text)).not.toContain(secret);
      expect(String(turn.context_text)).not.toContain(secret);
      const allContinuityText = JSON.stringify(db.prepare(`SELECT redacted_text, metadata_json FROM memory_events
        WHERE source_type = 'continuity_ledger' ORDER BY created_at, id`).all());
      expect(allContinuityText).not.toContain(secret);
    } finally {
      db.close();
    }
  });

  it('auto-resumes exactly one interrupted task for a known continuation phrase without duplicating the task', async () => {
    const f = await fixture('resume-one');
    const seeded = await f.runtime.memory.beginContinuityTurn(
      f.scope, 'seed-route-one', 'Build durable continuity', undefined,
      { objective: 'Build durable continuity' }, Date.now() + 60_000,
    );
    await f.runtime.memory.closeContinuityTurn(f.scope, seeded.turnId, 'interrupted');
    const before = await f.runtime.memory.getContinuitySnapshot(f.scope);
    expect(before.unfinishedPlans.map((task) => task.taskId)).toContain(seeded.taskId);

    const routed = await call(f.baseUrl, f.principal.key, { task: 'lanjutkan' });
    expect(routed.result.continuityStatus).toBe('healthy');
    expect(routed.result.continuityTaskId).toBe(seeded.taskId);
    expect(routed.result.continuityTurnId).toMatch(UUID_RE);
    expect(routed.result.continuityResumeCandidates).toEqual([]);

    const task = await f.runtime.memory.getContinuityTask(f.scope, seeded.taskId);
    expect(task?.status).toBe('running');
    const db = new DatabaseSync(f.runtime.memory.config.dbPath, { readOnly: true });
    try {
      expect(Number((db.prepare('SELECT count(*) AS count FROM continuity_tasks').get() as any).count)).toBe(1);
      expect(Number((db.prepare('SELECT count(*) AS count FROM continuity_turns').get() as any).count)).toBe(2);
    } finally {
      db.close();
    }
  });

  it('returns deterministic resume candidates and creates no new task/turn when a continuation phrase is ambiguous', async () => {
    const f = await fixture('resume-ambiguous');
    const first = await f.runtime.memory.beginContinuityTurn(
      f.scope, 'seed-route-a', 'First interrupted task', undefined,
      { objective: 'First interrupted task' }, Date.now() + 60_000,
    );
    await f.runtime.memory.closeContinuityTurn(f.scope, first.turnId, 'interrupted');
    const second = await f.runtime.memory.beginContinuityTurn(
      f.scope, 'seed-route-b', 'Second interrupted task', undefined,
      { objective: 'Second interrupted task' }, Date.now() + 60_000,
    );
    await f.runtime.memory.closeContinuityTurn(f.scope, second.turnId, 'interrupted');

    const routed = await call(f.baseUrl, f.principal.key, { task: 'continue' });
    expect(routed.raw.result.isError).not.toBe(true);
    expect(routed.result.continuityStatus).toBe('ambiguous');
    expect(routed.result.continuityTurnId).toBeNull();
    expect(routed.result.continuityTaskId).toBeNull();
    expect(routed.result.continuityResumeCandidates.map((item: any) => item.taskId).sort())
      .toEqual([first.taskId, second.taskId].sort());

    const db = new DatabaseSync(f.runtime.memory.config.dbPath, { readOnly: true });
    try {
      expect(Number((db.prepare('SELECT count(*) AS count FROM continuity_tasks').get() as any).count)).toBe(2);
      expect(Number((db.prepare('SELECT count(*) AS count FROM continuity_turns').get() as any).count)).toBe(2);
    } finally {
      db.close();
    }
    const storedRoute = f.runtime.routes.get(routed.result.routeContextId)!;
    expect(storedRoute.continuityTaskId).toBeUndefined();
    expect(storedRoute.continuityTurnId).toBeUndefined();
  });

  it('keeps capability routing available and reports degraded continuity without inventing persisted task state', async () => {
    const f = await fixture('degraded');
    const original = f.runtime.memory.beginContinuityTurn.bind(f.runtime.memory);
    (f.runtime.memory as any).beginContinuityTurn = async () => {
      throw new Error('simulated continuity persistence failure');
    };
    try {
      const routed = await call(f.baseUrl, f.principal.key, {
        task: 'Implement a normal routed task',
        continuity: { objective: 'This objective must not be claimed as persisted' },
      });
      expect(routed.raw.result.isError).not.toBe(true);
      expect(routed.result.routeContextId).toMatch(UUID_RE);
      expect(routed.result.memoryStatus).toBe('healthy');
      expect(routed.result.continuityStatus).toBe('degraded');
      expect(routed.result.continuityTurnId).toBeNull();
      expect(routed.result.continuityTaskId).toBeNull();
      const storedRoute = f.runtime.routes.get(routed.result.routeContextId)!;
      expect(storedRoute.continuityTurnId).toBeUndefined();
      expect(storedRoute.continuityTaskId).toBeUndefined();
    } finally {
      (f.runtime.memory as any).beginContinuityTurn = original;
    }
  });
});
