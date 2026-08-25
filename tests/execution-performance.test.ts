import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ContinuitySnapshotBuilder } from '../src/continuity/snapshot.js';
import { validateExecutionDag, type ValidatedExecutionNode } from '../src/execution/dag.js';
import type { ExecutionResultMarker } from '../src/execution/log-store.js';
import type { ExecutionRunHandle } from '../src/execution/runner.js';
import type { ExecutionRunnerLike } from '../src/execution/scheduler.js';
import { ExecutionService } from '../src/execution/service.js';
import type { ExecutionScope } from '../src/execution/types.js';
import { MemoryStore } from '../src/memory/store.js';
import { MemoryWorkerClient } from '../src/memory/worker-client.js';
import { WorkspacePolicy } from '../src/runtime/workspace.js';

const roots: string[] = [];
const services: ExecutionService[] = [];
const memoryStores: MemoryStore[] = [];

function percentile(values: number[], fraction: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1));
  return ordered[index] ?? 0;
}

async function timings(operation: () => Promise<void>, samples = 20, warmup = 3): Promise<number[]> {
  for (let index = 0; index < warmup; index += 1) await operation();
  const values: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    await operation();
    values.push(performance.now() - started);
  }
  return values;
}

function resultMarker(
  runId: string,
  nodeId: string,
  attemptId: string,
  attemptNo: number,
  state: ExecutionResultMarker['state'] = 'succeeded',
): ExecutionResultMarker {
  const now = Date.now();
  return {
    version: 1,
    runId,
    nodeId,
    attemptId,
    attemptNo,
    state,
    startedAt: now - 1,
    finishedAt: now,
    exitCode: state === 'succeeded' ? 0 : 1,
    signal: null,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutSha256: '0'.repeat(64),
    stderrSha256: '0'.repeat(64),
  };
}

class ControlledRunner implements ExecutionRunnerLike {
  readonly starts: Array<{ runId: string; nodeId: string; attemptId: string; attemptNo: number }> = [];
  readonly startCounts = new Map<string, number>();
  active = 0;
  maxActive = 0;
  private readonly pending = new Map<string, (marker: ExecutionResultMarker) => void>();

  async start(runId: string, node: ValidatedExecutionNode, attemptId: string, attemptNo: number): Promise<ExecutionRunHandle> {
    this.starts.push({ runId, nodeId: node.id, attemptId, attemptNo });
    this.startCounts.set(`${runId}/${node.id}`, (this.startCounts.get(`${runId}/${node.id}`) ?? 0) + 1);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    let settled = false;
    let resolve!: (marker: ExecutionResultMarker) => void;
    const completion = new Promise<ExecutionResultMarker>((res) => { resolve = res; });
    const settle = (state: ExecutionResultMarker['state']) => {
      if (settled) return;
      settled = true;
      this.active = Math.max(0, this.active - 1);
      this.pending.delete(`${runId}/${node.id}/${attemptNo}`);
      resolve(resultMarker(runId, node.id, attemptId, attemptNo, state));
    };
    this.pending.set(`${runId}/${node.id}/${attemptNo}`, (marker) => {
      if (settled) return;
      settled = true;
      this.active = Math.max(0, this.active - 1);
      this.pending.delete(`${runId}/${node.id}/${attemptNo}`);
      resolve(marker);
    });
    return {
      pid: 30_000 + this.starts.length,
      completion,
      terminate: (state = 'cancelled') => settle(state),
    };
  }

  complete(runId: string, nodeId: string, attemptNo = 1, state: ExecutionResultMarker['state'] = 'succeeded'): void {
    const key = `${runId}/${nodeId}/${attemptNo}`;
    const resolve = this.pending.get(key);
    const started = this.starts.find((item) => item.runId === runId && item.nodeId === nodeId && item.attemptNo === attemptNo);
    if (!resolve || !started) throw new Error(`No pending execution ${key}`);
    resolve(resultMarker(runId, nodeId, started.attemptId, attemptNo, state));
  }
}

async function executionFixture(label: string, runner = new ControlledRunner(), maxConcurrency = 4) {
  const root = await mkdtemp(path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), `agent-core-perf-${label}-`));
  roots.push(root);
  const work = path.join(root, 'work');
  await mkdir(work, { recursive: true });
  const base = loadConfig({}, root).execution;
  const service = new ExecutionService({
    ...base,
    enabled: true,
    dbPath: path.join(root, 'runtime', 'execution', `${label}.sqlite`),
    logRoot: path.join(root, 'runtime', 'execution', 'runs'),
    maxConcurrency,
    maxNodes: 128,
    waitMaxMs: 60_000,
  }, new WorkspacePolicy([root]), { runner });
  await service.open();
  services.push(service);
  return {
    root,
    work,
    service,
    runner,
    scope: { principalId: 'perf-principal', projectId: root } satisfies ExecutionScope,
  };
}

async function seedContinuityTasks(client: MemoryWorkerClient, principalId: string, projectId: string, count: number): Promise<void> {
  const batchSize = 250;
  const baseTime = 2_100_000_000_000;
  for (let offset = 0; offset < count; offset += batchSize) {
    const operations: any[] = [];
    const end = Math.min(count, offset + batchSize);
    for (let index = offset; index < end; index += 1) {
      const id = `task-${String(index).padStart(6, '0')}`;
      const status = index < 10 ? 'running'
        : index < 20 ? 'blocked'
          : index < 30 ? 'deferred'
            : index < 40 ? 'planned'
              : 'completed';
      const createdAt = baseTime + index;
      const completedAt = status === 'completed' ? createdAt + 100 : null;
      operations.push({
        kind: 'run',
        sql: `INSERT INTO continuity_tasks(
          id, principal_id, project_id, parent_task_id, title, objective, acceptance_json,
          constraints_json, status, priority, blocker_json, last_checkpoint_id,
          created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, NULL, ?, ?, '[]', '[]', ?, ?, '[]', NULL, ?, ?, ?)`,
        params: [
          id,
          principalId,
          projectId,
          `Synthetic task ${index}`,
          `Objective ${index}`,
          status,
          index % 7,
          createdAt,
          createdAt,
          completedAt,
        ],
      });
    }
    await client.transaction(operations);
  }
}

async function eventually(assertion: () => void | Promise<void>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  throw lastError;
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close().catch(() => undefined)));
  await Promise.all(memoryStores.splice(0).map((store) => store.close().catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const performanceGate = process.env.AGENT_CORE_PERFORMANCE_GATES === '1' ? it : it.skip;

describe('Task 20 performance, isolation, and determinism gates', () => {
  performanceGate('builds an identical continuity snapshot at 10k tasks with p95 below 50 ms', async () => {
    const root = await mkdtemp(path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), 'agent-core-continuity-perf-'));
    roots.push(root);
    const client = new MemoryWorkerClient();
    const store = new MemoryStore(client);
    memoryStores.push(store);
    await store.open({ dbPath: path.join(root, 'memory.sqlite') });
    const scope = { principalId: 'continuity-perf-principal', projectId: 'continuity-perf-project' };
    await seedContinuityTasks(client, scope.principalId, scope.projectId, 10_000);
    const builder = new ContinuitySnapshotBuilder(client);

    const first = await builder.build(scope);
    const second = await builder.build(scope);
    expect(second.snapshotHash).toBe(first.snapshotHash);
    expect(second).toEqual(first);

    const measured = await timings(async () => { void await builder.build(scope); }, 20, 3);
    expect(percentile(measured, 0.95)).toBeLessThan(50);
  }, 30_000);

  performanceGate('validates a 128-node DAG deterministically with p95 below 50 ms', async () => {
    const root = await mkdtemp(path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), 'agent-core-dag-perf-'));
    roots.push(root);
    const work = path.join(root, 'work');
    await mkdir(work, { recursive: true });
    const workspace = new WorkspacePolicy([root]);
    const nodes = Array.from({ length: 128 }, (_, index) => ({
      id: `N${String(index).padStart(3, '0')}`,
      purpose: `node ${index}`,
      command: `Write-Output '${index}'`,
      cwd: work,
      ...(index === 0 ? {} : { dependsOn: [`N${String(index - 1).padStart(3, '0')}`] }),
    }));

    const first = await validateExecutionDag(nodes, { workspace, maxNodes: 128 });
    const second = await validateExecutionDag(nodes, { workspace, maxNodes: 128 });
    expect(second.topologicalOrder).toEqual(first.topologicalOrder);

    const measured = await timings(async () => { void await validateExecutionDag(nodes, { workspace, maxNodes: 128 }); }, 20, 3);
    expect(percentile(measured, 0.95)).toBeLessThan(50);
  }, 30_000);

  performanceGate('dispatches ready nodes below 100 ms p95 and never exceeds the configured concurrency bound', async () => {
    const dispatchMs: number[] = [];
    for (let sample = 0; sample < 12; sample += 1) {
      const runner = new ControlledRunner();
      const f = await executionFixture(`dispatch-${sample}`, runner, 4);
      const created = await f.service.create(f.scope, {
        objective: `dispatch sample ${sample}`,
        maxConcurrency: 4,
        nodes: Array.from({ length: 128 }, (_, index) => ({
          id: `N${String(index).padStart(3, '0')}`,
          purpose: `node ${index}`,
          command: `Write-Output '${index}'`,
          cwd: f.work,
        })),
      });
      const startedAt = performance.now();
      await f.service.start(f.scope, created.runId);
      dispatchMs.push(performance.now() - startedAt);
      expect(runner.active).toBe(4);
      expect(runner.maxActive).toBeLessThanOrEqual(4);
      expect(runner.starts.slice(0, 4).map((item) => item.nodeId)).toEqual(['N000', 'N001', 'N002', 'N003']);
      await f.service.cancel(f.scope, created.runId);
      await f.service.close();
      services.splice(services.indexOf(f.service), 1);
    }
    expect(percentile(dispatchMs.slice(2), 0.95)).toBeLessThan(100);
  }, 60_000);

  performanceGate('delivers a persisted wake below 250 ms p95 without DB busy-polling', async () => {
    const wakeMs: number[] = [];
    for (let sample = 0; sample < 12; sample += 1) {
      const f = await executionFixture(`wake-${sample}`);
      const created = await f.service.create(f.scope, {
        objective: `wake sample ${sample}`,
        nodes: [{ id: 'A', purpose: 'A', command: "Write-Output 'A'", cwd: f.work }],
      });
      const originalGetEvents = f.service.store.getEvents.bind(f.service.store);
      let reads = 0;
      f.service.store.getEvents = (async (...args: Parameters<typeof originalGetEvents>) => {
        reads += 1;
        return originalGetEvents(...args);
      }) as typeof f.service.store.getEvents;

      const startedAt = performance.now();
      const waiting = f.service.wait(
        f.scope,
        created.runId,
        created.lastEventSequence,
        { eventTypes: ['node.output_available'], nodeIds: ['A'] },
        2_000,
      );
      await new Promise((resolve) => setImmediate(resolve));
      await f.service.journal.record(f.scope, created.runId, 'node.output_available', { nodeId: 'A', payload: { sample } });
      const result = await waiting;
      wakeMs.push(performance.now() - startedAt);
      expect(result.event).toMatchObject({ eventType: 'node.output_available', nodeId: 'A' });
      expect(reads).toBeLessThanOrEqual(2);
      await f.service.close();
      services.splice(services.indexOf(f.service), 1);
    }
    expect(percentile(wakeMs.slice(2), 0.95)).toBeLessThan(250);
  }, 30_000);

  it('serializes concurrent terminal events so a newly unlocked dependent is dispatched exactly once', async () => {
    const runner = new ControlledRunner();
    const f = await executionFixture('double-dispatch', runner, 4);
    const created = await f.service.create(f.scope, {
      objective: 'concurrent terminal events must not double-dispatch C',
      nodes: [
        { id: 'A', purpose: 'A', command: "Write-Output 'A'", cwd: f.work },
        { id: 'B', purpose: 'B', command: "Write-Output 'B'", cwd: f.work },
        { id: 'C', purpose: 'C', command: "Write-Output 'C'", cwd: f.work, dependsOn: ['A', 'B'] },
      ],
    });
    await f.service.start(f.scope, created.runId);
    runner.complete(created.runId, 'A');
    runner.complete(created.runId, 'B');
    await eventually(() => expect(runner.startCounts.get(`${created.runId}/C`)).toBe(1));
    expect(runner.startCounts.get(`${created.runId}/C`)).toBe(1);
    runner.complete(created.runId, 'C');
    await eventually(async () => expect((await f.service.status(f.scope, created.runId))?.state).toBe('completed'));
  });

  it('keeps raw log access principal/project scoped and hard-bounds read size', async () => {
    const f = await executionFixture('log-scope');
    const created = await f.service.create(f.scope, {
      objective: 'log isolation fixture',
      nodes: [{ id: 'A', purpose: 'A', command: "[Console]::Out.Write('ABCDEFGHIJK')", cwd: f.work }],
    });
    await f.service.start(f.scope, created.runId);
    const paths = f.service.logs.paths(created.runId, 'A', 1);
    await mkdir(paths.directory, { recursive: true });
    await writeFile(paths.stdoutPath, 'ABCDEFGHIJK', 'utf8');
    await writeFile(paths.stderrPath, '', 'utf8');
    f.runner.complete(created.runId, 'A');
    await eventually(async () => expect((await f.service.status(f.scope, created.runId))?.state).toBe('completed'));

    await expect(f.service.readLog(
      { principalId: 'other-principal', projectId: f.root }, created.runId, 'A', 1, 'stdout', 0, 5,
    )).rejects.toMatchObject({ code: 'EXECUTION_RUN_NOT_FOUND' });
    await expect(f.service.readLog(
      { principalId: f.scope.principalId, projectId: `${f.root}-other` }, created.runId, 'A', 1, 'stdout', 0, 5,
    )).rejects.toMatchObject({ code: 'EXECUTION_RUN_NOT_FOUND' });
    await expect(f.service.readLog(f.scope, created.runId, 'A', 1, 'stdout', 0, 1024 * 1024 + 1))
      .rejects.toMatchObject({ code: 'EXECUTION_LOG_READ_LIMIT_INVALID' });
    expect((await f.service.readLog(f.scope, created.runId, 'A', 1, 'stdout', 0, 5)).data).toBe('ABCDE');
  });
});
