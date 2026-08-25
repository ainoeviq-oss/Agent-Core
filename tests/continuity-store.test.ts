import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ContinuityStore, ContinuityStoreError } from '../src/continuity/store.js';
import { loadConfig } from '../src/config.js';
import { MemoryService } from '../src/memory/service.js';
import { MemoryStore } from '../src/memory/store.js';
import type { MemoryScope } from '../src/memory/types.js';
import { MemoryWorkerClient } from '../src/memory/worker-client.js';

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];

function expectStoreCode(promise: Promise<unknown>, code: string) {
  return expect(promise).rejects.toMatchObject({ name: 'ContinuityStoreError', code });
}

async function fixture(label: string) {
  const root = await mkdtemp(path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), `agent-core-continuity-store-${label}-`));
  roots.push(root);
  const dbPath = path.join(root, 'runtime', 'memory', 'continuity.sqlite');
  const client = new MemoryWorkerClient();
  const memory = new MemoryStore(client);
  await memory.open({ dbPath, busyTimeoutMs: 1000 });
  closers.push(() => memory.close());
  const continuity = new ContinuityStore(client);
  const scope: MemoryScope = { principalId: 'principal-a', projectId: 'project-a' };
  return { root, dbPath, client, memory, continuity, scope };
}

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    try { await close(); } catch {}
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ContinuityStore transactional ledger', () => {
  it('begins a redacted running task/turn and isolates reads by principal and project', async () => {
    const f = await fixture('scope');
    const started = await f.continuity.beginTurn(
      f.scope,
      'route-scope-1',
      'Implement continuity password=plain-secret',
      'context token=plain-token',
      {
        objective: 'Durable continuity',
        acceptanceCriteria: ['Survives restart'],
        constraints: ['F: only'],
      },
      Date.now() + 60_000,
    );

    const task = await f.continuity.getTask(f.scope, started.taskId);
    expect(task).toMatchObject({
      taskId: started.taskId,
      principalId: 'principal-a',
      projectId: 'project-a',
      title: 'Durable continuity',
      objective: 'Durable continuity',
      acceptanceCriteria: ['Survives restart'],
      constraints: ['F: only'],
      status: 'running',
    });

    expect(await f.continuity.getTask({ principalId: 'principal-b', projectId: 'project-a' }, started.taskId)).toBeNull();
    expect(await f.continuity.getTask({ principalId: 'principal-a', projectId: 'project-b' }, started.taskId)).toBeNull();

    const [turn] = await f.client.query<Record<string, unknown>>(
      'SELECT input_text, context_text, state, input_hash FROM continuity_turns WHERE id = ?',
      [started.turnId],
    );
    expect(turn.state).toBe('open');
    expect(String(turn.input_text)).toContain('[REDACTED:PASSWORD]');
    expect(String(turn.context_text)).toContain('[REDACTED:TOKEN]');
    expect(`${turn.input_text} ${turn.context_text}`).not.toContain('plain-secret');
    expect(`${turn.input_text} ${turn.context_text}`).not.toContain('plain-token');
    expect(String(turn.input_hash)).toMatch(/^[0-9a-f]{64}$/);

    const events = await f.client.query<{ event_type: string }>(
      'SELECT event_type FROM memory_events WHERE principal_id = ? AND IFNULL(project_id, \'\') = ? ORDER BY created_at, id',
      ['principal-a', 'project-a'],
    );
    expect(events.map((row) => row.event_type)).toEqual([
      'continuity.task_state_changed',
      'continuity.turn_opened',
    ]);
  });

  it('supports explicit scoped resume without duplicating the task and records the state transition', async () => {
    const f = await fixture('resume');
    const first = await f.continuity.beginTurn(f.scope, 'route-resume-1', 'Build continuity', undefined, {}, Date.now() + 60_000);
    await f.continuity.closeTurn(f.scope, first.turnId, 'interrupted');
    expect((await f.continuity.getTask(f.scope, first.taskId))?.status).toBe('interrupted');

    const second = await f.continuity.beginTurn(
      f.scope,
      'route-resume-2',
      'Continue continuity',
      undefined,
      { resumeTaskId: first.taskId },
      Date.now() + 60_000,
    );
    expect(second.taskId).toBe(first.taskId);
    expect(second.turnId).not.toBe(first.turnId);
    expect((await f.continuity.getTask(f.scope, first.taskId))?.status).toBe('running');

    const [{ count }] = await f.client.query<{ count: number }>(
      'SELECT count(*) AS count FROM continuity_tasks WHERE principal_id = ? AND IFNULL(project_id, \'\') = ?',
      ['principal-a', 'project-a'],
    );
    expect(Number(count)).toBe(1);

    await expectStoreCode(
      f.continuity.beginTurn(
        { principalId: 'principal-b', projectId: 'project-a' },
        'route-resume-cross-principal',
        'Continue',
        undefined,
        { resumeTaskId: first.taskId },
        Date.now() + 60_000,
      ),
      'CONTINUITY_TASK_NOT_FOUND',
    );
  });

  it('creates deterministic checkpoint hashes, validates state transitions, and writes frontier + provenance atomically', async () => {
    const f = await fixture('checkpoint');
    const started = await f.continuity.beginTurn(f.scope, 'route-checkpoint-1', 'Implement task', undefined, {}, Date.now() + 60_000);

    const runningInput = {
      routeContextId: 'route-checkpoint-1',
      status: 'running' as const,
      summary: 'Tests are running',
      evidence: [{ type: 'test' as const, ref: 'tests/example.test.ts', result: 'green' }],
    };
    const first = await f.continuity.checkpoint(f.scope, started.taskId, started.turnId, runningInput);
    const second = await f.continuity.checkpoint(f.scope, started.taskId, started.turnId, runningInput);
    expect(first.snapshotHash).toBe(second.snapshotHash);
    expect(first.snapshotHash).toMatch(/^[0-9a-f]{64}$/);

    const completed = await f.continuity.checkpoint(f.scope, started.taskId, started.turnId, {
      routeContextId: 'route-checkpoint-1',
      status: 'completed',
      summary: 'Task verified complete',
      evidence: [{ type: 'test', ref: 'tests/example.test.ts', result: 'pass' }],
      blockers: [],
      nextCandidates: [
        { title: 'Lower priority', rationale: 'Follow-up', priority: 1 },
        { title: 'Higher priority', rationale: 'Next critical path', priority: 5 },
      ],
    });
    expect(completed.taskStatus).toBe('completed');
    expect((await f.continuity.getTask(f.scope, started.taskId))?.status).toBe('completed');

    const frontier = await f.continuity.listFrontier(f.scope, 5);
    expect(frontier.map((row) => [row.title, row.priority])).toEqual([
      ['Higher priority', 5],
      ['Lower priority', 1],
    ]);

    const before = await f.client.query<{ checkpoints: number; events: number }>(`
      SELECT
        (SELECT count(*) FROM continuity_checkpoints) AS checkpoints,
        (SELECT count(*) FROM memory_events) AS events
    `);
    await expectStoreCode(
      f.continuity.checkpoint(f.scope, started.taskId, started.turnId, {
        routeContextId: 'route-checkpoint-1',
        status: 'running',
        summary: 'Illegal reopen after completion',
      }),
      'CONTINUITY_TRANSITION_INVALID',
    );
    const after = await f.client.query<{ checkpoints: number; events: number }>(`
      SELECT
        (SELECT count(*) FROM continuity_checkpoints) AS checkpoints,
        (SELECT count(*) FROM memory_events) AS events
    `);
    expect(after).toEqual(before);

    const eventTypes = (await f.client.query<{ event_type: string }>(
      'SELECT event_type FROM memory_events ORDER BY created_at, id',
    )).map((row) => row.event_type);
    expect(eventTypes.filter((event) => event === 'continuity.checkpoint_created')).toHaveLength(3);
    expect(eventTypes.filter((event) => event === 'continuity.frontier_added')).toHaveLength(2);
    expect(eventTypes).toContain('continuity.task_state_changed');
  });

  it('keeps frontier scoped and deterministically ordered with a bounded limit', async () => {
    const f = await fixture('frontier');
    const started = await f.continuity.beginTurn(f.scope, 'route-frontier-1', 'Complete parent', undefined, {}, Date.now() + 60_000);
    await f.continuity.checkpoint(f.scope, started.taskId, started.turnId, {
      routeContextId: 'route-frontier-1',
      status: 'completed',
      summary: 'done',
      nextCandidates: [
        { title: 'B', rationale: 'same priority', priority: 2 },
        { title: 'A', rationale: 'same priority', priority: 2 },
        { title: 'C', rationale: 'highest', priority: 3 },
      ],
    });

    expect((await f.continuity.listFrontier(f.scope, 2)).map((row) => row.title)).toEqual(['C', 'B']);
    expect(await f.continuity.listFrontier({ principalId: 'principal-b', projectId: 'project-a' }, 5)).toEqual([]);
    expect(await f.continuity.listFrontier({ principalId: 'principal-a', projectId: 'project-b' }, 5)).toEqual([]);
    await expectStoreCode(f.continuity.listFrontier(f.scope, 0), 'CONTINUITY_LIMIT_INVALID');
  });

  it('requires a terminal task before a turn can close cleanly; interrupted close marks unfinished work resumable', async () => {
    const f = await fixture('close');
    const interrupted = await f.continuity.beginTurn(f.scope, 'route-close-1', 'Interrupted work', undefined, {}, Date.now() + 60_000);
    await expectStoreCode(f.continuity.closeTurn(f.scope, interrupted.turnId, 'closed'), 'CONTINUITY_TASK_NOT_TERMINAL');
    await f.continuity.closeTurn(f.scope, interrupted.turnId, 'interrupted');
    expect((await f.continuity.getTask(f.scope, interrupted.taskId))?.status).toBe('interrupted');

    const completed = await f.continuity.beginTurn(f.scope, 'route-close-2', 'Terminal work', undefined, {}, Date.now() + 60_000);
    await f.continuity.checkpoint(f.scope, completed.taskId, completed.turnId, {
      routeContextId: 'route-close-2', status: 'completed', summary: 'project done', projectTerminal: true,
    });
    await f.continuity.closeTurn(f.scope, completed.turnId, 'closed');
    const [turn] = await f.client.query<Record<string, unknown>>('SELECT state, closed_at FROM continuity_turns WHERE id = ?', [completed.turnId]);
    expect(turn.state).toBe('closed');
    expect(Number(turn.closed_at)).toBeGreaterThan(0);
  });

  it('is wired into MemoryService using the same DMF worker/database lifecycle', async () => {
    const root = await mkdtemp(path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), 'agent-core-continuity-service-'));
    roots.push(root);
    const base = loadConfig({}, root).memory;
    const service = new MemoryService({
      ...base,
      enabled: true,
      dbPath: path.join(root, 'runtime', 'memory', 'service.sqlite'),
      busyTimeoutMs: 1000,
    });
    closers.push(() => service.close());
    const scope: MemoryScope = { principalId: 'service-principal', projectId: root };

    const started = await service.beginContinuityTurn(
      scope, 'route-service-1', 'Service continuity', undefined, { objective: 'Shared worker proof' }, Date.now() + 60_000,
    );
    const checkpoint = await service.checkpointContinuity(scope, started.taskId, started.turnId, {
      routeContextId: 'route-service-1', status: 'completed', summary: 'done', projectTerminal: true,
    });
    await service.closeContinuityTurn(scope, started.turnId, 'closed');

    expect(checkpoint.taskStatus).toBe('completed');
    expect((await service.getContinuityTask(scope, started.taskId))?.objective).toBe('Shared worker proof');
    expect((await service.status(scope)).integrity).toBe('ok');
  });
});
