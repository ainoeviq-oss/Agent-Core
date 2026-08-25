import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONTINUITY_SNAPSHOT_LIMITS,
  ContinuitySnapshotBuilder,
} from '../src/continuity/snapshot.js';
import { ContinuityStore } from '../src/continuity/store.js';
import { loadConfig } from '../src/config.js';
import { MemoryService } from '../src/memory/service.js';
import { MemoryStore } from '../src/memory/store.js';
import type { MemoryScope } from '../src/memory/types.js';
import { MemoryWorkerClient } from '../src/memory/worker-client.js';

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];

async function fixture(label: string) {
  const root = await mkdtemp(path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), `agent-core-continuity-snapshot-${label}-`));
  roots.push(root);
  const client = new MemoryWorkerClient();
  const memory = new MemoryStore(client);
  await memory.open({ dbPath: path.join(root, 'snapshot.sqlite'), busyTimeoutMs: 1000 });
  closers.push(() => memory.close());
  const continuity = new ContinuityStore(client);
  const builder = new ContinuitySnapshotBuilder(client);
  const scope: MemoryScope = { principalId: 'principal-snapshot', projectId: 'project-snapshot' };
  return { root, client, memory, continuity, builder, scope };
}

async function seedTask(
  client: MemoryWorkerClient,
  scope: MemoryScope,
  input: { title: string; objective?: string; status: string; priority?: number; updatedAt: number; completedAt?: number },
) {
  const id = randomUUID();
  await client.transaction([{
    kind: 'run',
    sql: `INSERT INTO continuity_tasks(
      id, principal_id, project_id, parent_task_id, title, objective, acceptance_json, constraints_json,
      status, priority, blocker_json, last_checkpoint_id, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, NULL, ?, ?, '[]', '[]', ?, ?, '[]', NULL, ?, ?, ?)`,
    params: [
      id, scope.principalId, scope.projectId ?? null, input.title, input.objective ?? null,
      input.status, input.priority ?? 0, input.updatedAt, input.updatedAt, input.completedAt ?? null,
    ],
  }]);
  return id;
}

function payloadChars(snapshot: Awaited<ReturnType<ContinuitySnapshotBuilder['build']>>): number {
  const { snapshotHash: _hash, ...payload } = snapshot;
  return JSON.stringify(payload).length;
}

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    try { await close(); } catch {}
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('deterministic continuity snapshot', () => {
  it('rehydrates bounded state categories in stable order with an identical hash for unchanged DB state', async () => {
    const f = await fixture('categories');

    const active = await f.continuity.beginTurn(
      f.scope, 'route-active', 'Active task', undefined, { objective: 'Current active objective' }, Date.now() + 60_000,
    );
    const blocked = await f.continuity.beginTurn(f.scope, 'route-blocked', 'Blocked task', undefined, {}, Date.now() + 60_000);
    await f.continuity.checkpoint(f.scope, blocked.taskId, blocked.turnId, {
      routeContextId: 'route-blocked', status: 'blocked', summary: 'Waiting on dependency', blockers: [{ code: 'DEP', detail: 'dependency' }],
    });
    const deferred = await f.continuity.beginTurn(f.scope, 'route-deferred', 'Deferred task', undefined, {}, Date.now() + 60_000);
    await f.continuity.checkpoint(f.scope, deferred.taskId, deferred.turnId, {
      routeContextId: 'route-deferred', status: 'deferred', summary: 'Later', deferred: [{ title: 'Later', reason: 'priority' }],
    });
    const completed = await f.continuity.beginTurn(f.scope, 'route-completed', 'Completed task', undefined, {}, Date.now() + 60_000);
    await f.continuity.checkpoint(f.scope, completed.taskId, completed.turnId, {
      routeContextId: 'route-completed', status: 'completed', summary: 'done',
      nextCandidates: [
        { title: 'Frontier high', rationale: 'critical', priority: 9 },
        { title: 'Frontier low', rationale: 'optional', priority: 1 },
      ],
    });
    await f.continuity.closeTurn(f.scope, completed.turnId, 'closed');
    const interrupted = await f.continuity.beginTurn(f.scope, 'route-interrupted', 'Interrupted task', undefined, {}, Date.now() + 60_000);
    await f.continuity.closeTurn(f.scope, interrupted.turnId, 'interrupted');

    const old = Date.now() - 100_000;
    const plannedId = await seedTask(f.client, f.scope, { title: 'Planned task', objective: 'Future objective', status: 'planned', priority: 7, updatedAt: old });
    const readyId = await seedTask(f.client, f.scope, { title: 'Ready task', status: 'ready', priority: 3, updatedAt: old + 1 });

    const first = await f.builder.build(f.scope);
    const second = await f.builder.build(f.scope);
    expect(second).toEqual(first);
    expect(first.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.currentObjective).toBe('Current active objective');
    expect(first.activeTasks.map((task) => task.taskId)).toContain(active.taskId);
    expect(first.blockedTasks.map((task) => task.taskId)).toContain(blocked.taskId);
    expect(first.deferredTasks.map((task) => task.taskId)).toContain(deferred.taskId);
    expect(first.recentCompleted.map((task) => task.taskId)).toContain(completed.taskId);
    expect(first.unfinishedPlans.map((task) => task.taskId)).toEqual(expect.arrayContaining([plannedId, readyId, interrupted.taskId]));
    expect(first.frontier.map((item) => item.title)).toEqual(['Frontier high', 'Frontier low']);
    expect(first.interruptedTurns.map((turn) => turn.turnId)).toContain(interrupted.turnId);

    expect(first.activeTasks.length).toBeLessThanOrEqual(CONTINUITY_SNAPSHOT_LIMITS.active);
    expect(first.recentCompleted.length).toBeLessThanOrEqual(CONTINUITY_SNAPSHOT_LIMITS.completed);
    expect(first.blockedTasks.length).toBeLessThanOrEqual(CONTINUITY_SNAPSHOT_LIMITS.blocked);
    expect(first.deferredTasks.length).toBeLessThanOrEqual(CONTINUITY_SNAPSHOT_LIMITS.deferred);
    expect(first.unfinishedPlans.length).toBeLessThanOrEqual(CONTINUITY_SNAPSHOT_LIMITS.unfinished);
    expect(first.frontier.length).toBeLessThanOrEqual(CONTINUITY_SNAPSHOT_LIMITS.frontier);
    expect(first.interruptedTurns.length).toBeLessThanOrEqual(CONTINUITY_SNAPSHOT_LIMITS.interrupted);
    expect(payloadChars(first)).toBeLessThanOrEqual(CONTINUITY_SNAPSHOT_LIMITS.characterBudget);

    const other = await f.builder.build({ principalId: 'principal-other', projectId: 'project-snapshot' });
    expect(other.currentObjective).toBeNull();
    expect(other.activeTasks).toEqual([]);
    expect(other.frontier).toEqual([]);
  });

  it('does not let 100+ large old completed tasks displace current active/deferred/frontier state under the character budget', async () => {
    const f = await fixture('history-pressure');
    const active = await f.continuity.beginTurn(
      f.scope, 'route-current-active', 'Current active', undefined, { objective: 'Do the current critical work' }, Date.now() + 60_000,
    );
    const deferred = await f.continuity.beginTurn(f.scope, 'route-current-deferred', 'Current deferred', undefined, {}, Date.now() + 60_000);
    await f.continuity.checkpoint(f.scope, deferred.taskId, deferred.turnId, {
      routeContextId: 'route-current-deferred', status: 'deferred', summary: 'defer deliberately',
    });
    const source = await f.continuity.beginTurn(f.scope, 'route-current-frontier', 'Frontier source', undefined, {}, Date.now() + 60_000);
    await f.continuity.checkpoint(f.scope, source.taskId, source.turnId, {
      routeContextId: 'route-current-frontier', status: 'completed', summary: 'source done',
      nextCandidates: [
        { title: 'Immediate next', rationale: 'important', priority: 10 },
        { title: 'Secondary next', rationale: 'useful', priority: 5 },
      ],
    });

    const oldBase = Date.now() - 10_000_000;
    for (let index = 0; index < 120; index += 1) {
      await seedTask(f.client, f.scope, {
        title: `old-${index}-${'x'.repeat(2500)}`,
        objective: `historical-${index}-${'y'.repeat(2500)}`,
        status: 'completed',
        priority: 0,
        updatedAt: oldBase + index,
        completedAt: oldBase + index,
      });
    }

    const snapshot = await f.builder.build(f.scope);
    expect(snapshot.currentObjective).toBe('Do the current critical work');
    expect(snapshot.activeTasks.map((task) => task.taskId)).toContain(active.taskId);
    expect(snapshot.deferredTasks.map((task) => task.taskId)).toContain(deferred.taskId);
    expect(snapshot.frontier.map((item) => item.title)).toEqual(['Immediate next', 'Secondary next']);
    expect(snapshot.recentCompleted.length).toBeLessThanOrEqual(CONTINUITY_SNAPSHOT_LIMITS.completed);
    expect(payloadChars(snapshot)).toBeLessThanOrEqual(CONTINUITY_SNAPSHOT_LIMITS.characterBudget);
  });

  it('is exposed through MemoryService on the same memory worker lifecycle', async () => {
    const root = await mkdtemp(path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), 'agent-core-continuity-snapshot-service-'));
    roots.push(root);
    const base = loadConfig({}, root).memory;
    const service = new MemoryService({ ...base, enabled: true, dbPath: path.join(root, 'service.sqlite'), busyTimeoutMs: 1000 });
    closers.push(() => service.close());
    const scope: MemoryScope = { principalId: 'service-snapshot-principal', projectId: root };
    await service.beginContinuityTurn(scope, 'route-service-snapshot', 'Task', undefined, { objective: 'Service snapshot objective' }, Date.now() + 60_000);
    const snapshot = await service.getContinuitySnapshot(scope);
    expect(snapshot.currentObjective).toBe('Service snapshot objective');
    expect(snapshot.activeTasks).toHaveLength(1);
    expect((await service.status(scope)).integrity).toBe('ok');
  });
});
