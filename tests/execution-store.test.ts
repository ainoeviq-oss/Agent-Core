import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionStore, ExecutionStoreError } from '../src/execution/store.js';
import { EXECUTION_NODE_STATES, EXECUTION_RUN_STATES } from '../src/execution/types.js';

const roots: string[] = [];
const stores: ExecutionStore[] = [];

async function fixture(label: string) {
  const root = await mkdtemp(path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), `agent-core-execution-store-${label}-`));
  roots.push(root);
  const store = new ExecutionStore();
  stores.push(store);
  await store.open({ dbPath: path.join(root, 'runtime', 'execution', 'execution.sqlite') });
  return { root, store };
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map(async (store) => {
    try { await store.close(); } catch {}
  }));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('persistent principal/project-scoped execution store', () => {
  it('exposes exact run/node state vocabularies', () => {
    expect(EXECUTION_RUN_STATES).toEqual(['planned', 'running', 'completed', 'failed', 'blocked', 'interrupted', 'cancelled']);
    expect(EXECUTION_NODE_STATES).toEqual(['queued', 'ready', 'running', 'succeeded', 'failed', 'blocked', 'interrupted', 'cancelled']);
  });

  it('creates and reopens durable planned runs with bounded metadata', async () => {
    const f = await fixture('durable');
    const scope = { principalId: 'principal-a', projectId: 'project-a' };
    const created = await f.store.createRun(scope, {
      objective: ' Build persistent multi-command execution ',
      continuityTaskId: 'continuity-task-a',
      originRouteContextId: 'route-a',
      maxConcurrency: 4,
      metadata: { source: 'task9', nested: { deterministic: true } },
    });
    expect(created.runId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(created.state).toBe('planned');

    const fetched = await f.store.getRun(scope, created.runId);
    expect(fetched).toMatchObject({
      runId: created.runId,
      principalId: 'principal-a',
      projectId: 'project-a',
      continuityTaskId: 'continuity-task-a',
      originRouteContextId: 'route-a',
      state: 'planned',
      objective: 'Build persistent multi-command execution',
      maxConcurrency: 4,
      lastEventSequence: 0,
      metadata: { source: 'task9', nested: { deterministic: true } },
    });

    const dbPath = (await f.store.status()).dbPath;
    await f.store.close();
    stores.splice(stores.indexOf(f.store), 1);
    const reopened = new ExecutionStore();
    stores.push(reopened);
    await reopened.open({ dbPath });
    expect((await reopened.getRun(scope, created.runId))?.runId).toBe(created.runId);
  });

  it('hides run existence across principals and projects and lists only the authenticated scope', async () => {
    const f = await fixture('scope');
    const scopeA = { principalId: 'principal-a', projectId: 'project-a' };
    const scopeOtherPrincipal = { principalId: 'principal-b', projectId: 'project-a' };
    const scopeOtherProject = { principalId: 'principal-a', projectId: 'project-b' };
    const first = await f.store.createRun(scopeA, { objective: 'First run', maxConcurrency: 2 });
    const second = await f.store.createRun(scopeA, { objective: 'Second run', maxConcurrency: 3 });
    await f.store.createRun(scopeOtherPrincipal, { objective: 'Other principal run', maxConcurrency: 1 });
    await f.store.createRun(scopeOtherProject, { objective: 'Other project run', maxConcurrency: 1 });

    expect(await f.store.getRun(scopeOtherPrincipal, first.runId)).toBeNull();
    expect(await f.store.getRun(scopeOtherProject, first.runId)).toBeNull();
    const own = await f.store.listRuns(scopeA, 10);
    expect(own.map((run) => run.runId).sort()).toEqual([first.runId, second.runId].sort());
    expect(own.every((run) => run.principalId === scopeA.principalId && run.projectId === scopeA.projectId)).toBe(true);
  });

  it('rejects invalid scope, empty objectives, invalid concurrency, and oversized list limits before persistence', async () => {
    const f = await fixture('validation');
    await expect(f.store.createRun({ principalId: '', projectId: 'project-a' }, { objective: 'invalid', maxConcurrency: 1 }))
      .rejects.toEqual(expect.objectContaining<Partial<ExecutionStoreError>>({ code: 'EXECUTION_SCOPE_REQUIRED' }));
    await expect(f.store.createRun({ principalId: 'principal-a', projectId: 'project-a' }, { objective: '   ', maxConcurrency: 1 }))
      .rejects.toEqual(expect.objectContaining<Partial<ExecutionStoreError>>({ code: 'EXECUTION_OBJECTIVE_REQUIRED' }));
    await expect(f.store.createRun({ principalId: 'principal-a', projectId: 'project-a' }, { objective: 'bad concurrency', maxConcurrency: 0 }))
      .rejects.toEqual(expect.objectContaining<Partial<ExecutionStoreError>>({ code: 'EXECUTION_CONCURRENCY_INVALID' }));
    await expect(f.store.listRuns({ principalId: 'principal-a', projectId: 'project-a' }, 1001))
      .rejects.toEqual(expect.objectContaining<Partial<ExecutionStoreError>>({ code: 'EXECUTION_LIMIT_INVALID' }));
  });
});
