import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { attachExecutionContinuity } from '../src/continuity/snapshot.js';
import { validateExecutionDag } from '../src/execution/dag.js';
import { ExecutionLogStore, type ExecutionResultMarker } from '../src/execution/log-store.js';
import { ExecutionMemoryBridge, type ExecutionMemoryWriter } from '../src/execution/memory-bridge.js';
import type { ExecutionRunHandle } from '../src/execution/runner.js';
import type { ExecutionRunnerLike } from '../src/execution/scheduler.js';
import { ExecutionService } from '../src/execution/service.js';
import { ExecutionStore } from '../src/execution/store.js';
import type { ValidatedExecutionNode } from '../src/execution/dag.js';
import type { ExecutionScope } from '../src/execution/types.js';
import { MemoryService } from '../src/memory/service.js';
import type { MemoryCommitRequest, MemoryCommitResult, MemoryScope, MemoryStatus } from '../src/memory/types.js';
import { WorkspacePolicy } from '../src/runtime/workspace.js';

const roots: string[] = [];
const services: ExecutionService[] = [];
const memories: MemoryService[] = [];

function terminal(
  runId: string,
  nodeId: string,
  attemptId: string,
  attemptNo: number,
  state: ExecutionResultMarker['state'],
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
    exitCode: state === 'succeeded' ? 0 : 9,
    signal: null,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutSha256: '0'.repeat(64),
    stderrSha256: '0'.repeat(64),
  };
}

class ControlledRunner implements ExecutionRunnerLike {
  readonly starts: Array<{ runId: string; node: ValidatedExecutionNode; attemptId: string; attemptNo: number }> = [];
  private readonly pending = new Map<string, (value: ExecutionResultMarker) => void>();

  async start(
    runId: string,
    node: ValidatedExecutionNode,
    attemptId: string,
    attemptNo: number,
  ): Promise<ExecutionRunHandle> {
    this.starts.push({ runId, node, attemptId, attemptNo });
    let resolve!: (value: ExecutionResultMarker) => void;
    const completion = new Promise<ExecutionResultMarker>((res) => { resolve = res; });
    this.pending.set(`${runId}/${node.id}/${attemptNo}`, resolve);
    return {
      pid: 30_000 + this.starts.length,
      completion,
      terminate: (state = 'cancelled') => resolve(terminal(runId, node.id, attemptId, attemptNo, state)),
    };
  }

  complete(runId: string, nodeId: string, attemptNo: number, state: ExecutionResultMarker['state']) {
    const key = `${runId}/${nodeId}/${attemptNo}`;
    const resolve = this.pending.get(key);
    if (!resolve) throw new Error(`No pending controlled attempt: ${key}`);
    const started = this.starts.find((item) => item.runId === runId && item.node.id === nodeId && item.attemptNo === attemptNo);
    if (!started) throw new Error(`No controlled start record: ${key}`);
    this.pending.delete(key);
    resolve(terminal(runId, nodeId, started.attemptId, attemptNo, state));
  }

  startedNodeIds(runId?: string): string[] {
    return this.starts.filter((item) => !runId || item.runId === runId).map((item) => item.node.id);
  }
}

class SwitchableMemoryWriter implements ExecutionMemoryWriter {
  healthy = false;
  readonly commits: MemoryCommitRequest[] = [];
  readonly events: Array<Record<string, unknown>> = [];

  async status(): Promise<MemoryStatus> {
    return {
      enabled: true,
      healthy: this.healthy,
      schemaVersion: 2,
      dbPath: 'acceptance-memory.sqlite',
      counts: {},
      integrity: this.healthy ? 'ok' : 'degraded:acceptance',
    };
  }

  async commit(request: MemoryCommitRequest): Promise<MemoryCommitResult> {
    if (!this.healthy) throw new Error('MEMORY_DEGRADED:acceptance');
    this.commits.push(request);
    return {
      memoryId: `memory-${this.commits.length}`,
      revisionId: `revision-${this.commits.length}`,
      eventId: `event-${this.commits.length}`,
      revisionNo: 1,
      deduplicated: false,
      state: 'active',
    };
  }

  async recordEvent(request: any): Promise<unknown> {
    if (!this.healthy) throw new Error('MEMORY_DEGRADED:acceptance');
    this.events.push(request);
    return { eventId: `event-${this.events.length}` };
  }
}

async function rootFixture(label: string) {
  const base = process.env.TEMP || process.env.TMP || os.tmpdir();
  const root = await mkdtemp(path.join(base, `agent-core-user-workflow-${label}-`));
  roots.push(root);
  const work = path.join(root, 'work');
  await mkdir(work, { recursive: true });
  const defaults = loadConfig({}, root);
  const executionConfig = {
    ...defaults.execution,
    enabled: true,
    dbPath: path.join(root, 'runtime', 'execution', 'acceptance.sqlite'),
    logRoot: path.join(root, 'runtime', 'execution', 'runs'),
    maxConcurrency: 4,
    waitMaxMs: 5_000,
  };
  const memoryConfig = {
    ...defaults.memory,
    enabled: true,
    dbPath: path.join(root, 'runtime', 'memory', 'acceptance.sqlite'),
  };
  const scope = { principalId: 'principal-acceptance', projectId: root } satisfies ExecutionScope;
  return { root, work, defaults, executionConfig, memoryConfig, scope, workspace: new WorkspacePolicy([root]) };
}

async function eventually(assertion: () => void | Promise<void>, timeoutMs = 4_000) {
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

async function openControlled(label: string, maxConcurrency = 4) {
  const f = await rootFixture(label);
  const runner = new ControlledRunner();
  const service = new ExecutionService(
    { ...f.executionConfig, maxConcurrency },
    f.workspace,
    { runner },
  );
  services.push(service);
  await service.open();
  return { ...f, runner, service };
}

async function seedMissingMarkerAttempt(f: Awaited<ReturnType<typeof rootFixture>>) {
  const store = new ExecutionStore();
  await store.open({ dbPath: f.executionConfig.dbPath });
  const graph = await validateExecutionDag([{
    id: 'A',
    purpose: 'restart recovery A',
    command: "Write-Output 'retry-after-restart'",
    cwd: f.work,
    timeoutMs: 5_000,
  }], { workspace: f.workspace });
  const run = await store.createRun(f.scope, {
    objective: 'restart missing result marker acceptance',
    continuityTaskId: 'task-recovery-acceptance',
    maxConcurrency: 1,
  });
  await store.persistGraph(f.scope, run.runId, graph.nodes);
  await store.setRunState(f.scope, run.runId, 'running');
  const logs = new ExecutionLogStore(f.executionConfig.logRoot);
  const paths = await logs.prepareAttempt(run.runId, 'A', 1);
  const attemptId = 'attempt-missing-marker-1';
  await store.createAttempt(f.scope, run.runId, 'A', attemptId, 1, paths);
  await store.setAttemptPid(f.scope, run.runId, attemptId, 999_999);
  await store.close();
  return { runId: run.runId, attemptId };
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close().catch(() => undefined)));
  await Promise.all(memories.splice(0).map((memory) => memory.close().catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Task 19 end-to-end user workflow acceptance A-J', () => {
  it('loads exactly the canonical A-J workflow scenarios', async () => {
    const fixturePath = path.join(process.cwd(), 'tests', 'fixtures', 'execution', 'user-workflow-scenarios.json');
    const scenarios = JSON.parse(await readFile(fixturePath, 'utf8')) as Array<{ id: string; name: string }>;
    expect(scenarios.map((scenario) => scenario.id)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']);
    expect(scenarios.every((scenario) => scenario.name.trim().length > 0)).toBe(true);
  });

  it('Scenarios A/G/J: fresh same-principal state preserves deferred work, frontier, active run, and never finalizes a task from process exit', async () => {
    const f = await rootFixture('agj');
    const memory = new MemoryService(f.memoryConfig);
    memories.push(memory);
    const execution = new ExecutionService(f.executionConfig, f.workspace);
    services.push(execution);
    await execution.open();

    const mainTurn = await memory.beginContinuityTurn(
      f.scope,
      'route-main-agj',
      'Input process output continuity',
      undefined,
      { objective: 'Input process output continuity' },
    );

    const completedRun = await execution.create(f.scope, {
      objective: 'verified process completion must not complete task',
      continuityTaskId: mainTurn.taskId,
      originRouteContextId: 'route-main-agj',
      nodes: [{ id: 'DONE', purpose: 'finish process only', command: "Write-Output 'process-complete'", cwd: f.work }],
    });
    await execution.start(f.scope, completedRun.runId);
    const completed = await execution.wait(
      f.scope,
      completedRun.runId,
      completedRun.lastEventSequence,
      { eventTypes: ['run.completed'] },
      5_000,
    );
    expect(completed.state.state).toBe('completed');
    expect((await memory.getContinuityTask(f.scope, mainTurn.taskId))?.status).toBe('running');

    await memory.checkpointContinuity(f.scope, mainTurn.taskId, mainTurn.turnId, {
      routeContextId: 'route-main-agj',
      status: 'interrupted',
      summary: 'Process completed, but user task is intentionally left resumable.',
      deferred: [{ title: 'Integrate optional branch later', reason: 'Not finalized in this session.' }],
      nextCandidates: [
        { title: 'Resume integration', rationale: 'Continue from durable checkpoint.', priority: 2 },
        { title: 'Review deferred branch', rationale: 'Re-evaluate optional work.', priority: 1 },
      ],
    });
    await memory.closeContinuityTurn(f.scope, mainTurn.turnId, 'interrupted');

    const activeRun = await execution.create(f.scope, {
      objective: 'active run visible to a fresh same-principal session',
      continuityTaskId: mainTurn.taskId,
      originRouteContextId: 'route-main-agj',
      nodes: [{ id: 'NEXT', purpose: 'planned follow-up', command: "Write-Output 'next'", cwd: f.work }],
    });

    const deferredTurn = await memory.beginContinuityTurn(
      f.scope,
      'route-deferred-agj',
      'Deferred companion task',
      undefined,
      { objective: 'Deferred companion task' },
    );
    await memory.checkpointContinuity(f.scope, deferredTurn.taskId, deferredTurn.turnId, {
      routeContextId: 'route-deferred-agj',
      status: 'deferred',
      summary: 'Explicitly deferred companion work.',
    });
    // Match the first-class task_checkpoint contract: deferred checkpoints keep the turn open.

    await execution.close();
    await memory.close();

    const reopenedMemory = new MemoryService(f.memoryConfig);
    memories.push(reopenedMemory);
    const reopenedExecution = new ExecutionService(f.executionConfig, f.workspace);
    services.push(reopenedExecution);
    await reopenedExecution.open();

    const baseSnapshot = await reopenedMemory.getContinuitySnapshot(f.scope);
    const resumeSnapshot = attachExecutionContinuity(baseSnapshot, await reopenedExecution.continuitySummary(f.scope));
    expect(resumeSnapshot.deferredTasks.map((task) => task.taskId)).toContain(deferredTurn.taskId);
    expect(resumeSnapshot.frontier.map((item) => item.title)).toEqual(['Resume integration', 'Review deferred branch']);
    expect(resumeSnapshot.unfinishedPlans.map((task) => task.taskId)).toContain(mainTurn.taskId);
    expect(resumeSnapshot.interruptedTurns.map((turn) => turn.turnId)).toContain(mainTurn.turnId);
    expect(resumeSnapshot.activeRuns.map((run) => run.runId)).toContain(activeRun.runId);
    expect(resumeSnapshot.activeRuns.find((run) => run.runId === activeRun.runId)?.continuityTaskId).toBe(mainTurn.taskId);
    expect((await reopenedMemory.getContinuityTask(f.scope, mainTurn.taskId))?.status).toBe('interrupted');
    expect((await reopenedExecution.status(f.scope, activeRun.runId))?.state).toBe('planned');
  }, 15_000);

  it('Scenarios B/C/D/F: independent work is concurrent, A completion wakes while B runs, dynamic C unlocks on A, and D waits for A+B', async () => {
    const f = await openControlled('bcdf');
    const created = await f.service.create(f.scope, {
      objective: 'B C D F integrated acceptance',
      nodes: [
        { id: 'D', purpose: 'wait for both A and B', command: "Write-Output 'D'", cwd: f.work, dependsOn: ['A', 'B'] },
        { id: 'B', purpose: 'independent B', command: "Write-Output 'B'", cwd: f.work },
        { id: 'A', purpose: 'independent A', command: "Write-Output 'A'", cwd: f.work },
      ],
    });
    await f.service.start(f.scope, created.runId);
    expect(f.runner.startedNodeIds(created.runId)).toEqual(['A', 'B']);
    const running = await f.service.status(f.scope, created.runId);
    expect(running?.nodes.filter((node) => node.state === 'running').map((node) => node.nodeId).sort()).toEqual(['A', 'B']);

    const waitingForA = f.service.wait(
      f.scope,
      created.runId,
      running!.lastEventSequence,
      { eventTypes: ['node.succeeded'], nodeIds: ['A'] },
      2_000,
    );
    f.runner.complete(created.runId, 'A', 1, 'succeeded');
    const woke = await waitingForA;
    expect(woke.timedOut).toBe(false);
    expect(woke.event).toMatchObject({ eventType: 'node.succeeded', nodeId: 'A' });
    expect(woke.state.nodes.find((node) => node.nodeId === 'B')?.state).toBe('running');
    expect(woke.state.nodes.find((node) => node.nodeId === 'D')?.state).toBe('queued');

    await f.service.addNodes(f.scope, created.runId, [
      { id: 'C', purpose: 'dynamic C after A', command: "Write-Output 'C'", cwd: f.work, dependsOn: ['A'] },
    ]);
    await eventually(() => expect(f.runner.startedNodeIds(created.runId)).toEqual(['A', 'B', 'C']));
    let status = await f.service.status(f.scope, created.runId);
    expect(status?.nodes.find((node) => node.nodeId === 'B')?.state).toBe('running');
    expect(status?.nodes.find((node) => node.nodeId === 'C')?.state).toBe('running');
    expect(status?.nodes.find((node) => node.nodeId === 'D')?.state).toBe('queued');

    f.runner.complete(created.runId, 'C', 1, 'succeeded');
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.runner.startedNodeIds(created.runId)).toEqual(['A', 'B', 'C']);

    f.runner.complete(created.runId, 'B', 1, 'succeeded');
    await eventually(() => expect(f.runner.startedNodeIds(created.runId)).toEqual(['A', 'B', 'C', 'D']));
    status = await f.service.status(f.scope, created.runId);
    expect(status?.nodes.find((node) => node.nodeId === 'D')?.state).toBe('running');

    f.runner.complete(created.runId, 'D', 1, 'succeeded');
    await eventually(async () => expect((await f.service.status(f.scope, created.runId))?.state).toBe('completed'));
  });

  it('Scenario E: A failure leaves B independent and explicit retry preserves attempt 1 then recovers the blocked dependent', async () => {
    const f = await openControlled('e');
    const created = await f.service.create(f.scope, {
      objective: 'failure isolation and retry acceptance',
      nodes: [
        { id: 'C', purpose: 'dependent C', command: "Write-Output 'C'", cwd: f.work, dependsOn: ['A'] },
        { id: 'B', purpose: 'independent B', command: "Write-Output 'B'", cwd: f.work },
        { id: 'A', purpose: 'retryable A', command: "Write-Output 'A'", cwd: f.work },
      ],
    });
    await f.service.start(f.scope, created.runId);
    f.runner.complete(created.runId, 'A', 1, 'failed');
    await eventually(async () => {
      const status = await f.service.status(f.scope, created.runId);
      expect(status?.nodes.find((node) => node.nodeId === 'A')?.state).toBe('failed');
      expect(status?.nodes.find((node) => node.nodeId === 'B')?.state).toBe('running');
      expect(status?.nodes.find((node) => node.nodeId === 'C')?.state).toBe('blocked');
    });

    await f.service.retry(f.scope, created.runId, 'A');
    await eventually(() => expect(f.runner.starts.filter((item) => item.runId === created.runId && item.node.id === 'A').map((item) => item.attemptNo)).toEqual([1, 2]));
    f.runner.complete(created.runId, 'A', 2, 'succeeded');
    await eventually(() => expect(f.runner.startedNodeIds(created.runId)).toEqual(['A', 'B', 'A', 'C']));
    expect((await f.service.status(f.scope, created.runId))?.nodes.find((node) => node.nodeId === 'B')?.state).toBe('running');

    f.runner.complete(created.runId, 'C', 1, 'succeeded');
    f.runner.complete(created.runId, 'B', 1, 'succeeded');
    await eventually(async () => expect((await f.service.status(f.scope, created.runId))?.state).toBe('completed'));
    const attempts = await f.service.store.listAttempts(f.scope, created.runId, 'A');
    expect(attempts.map((attempt) => [attempt.attemptNo, attempt.state])).toEqual([[1, 'failed'], [2, 'succeeded']]);
  });

  it('Scenario H: restart with a persisted running attempt and no terminal result marker is interrupted, never inferred successful', async () => {
    const f = await rootFixture('h');
    const seeded = await seedMissingMarkerAttempt(f);
    const reopened = new ExecutionService(f.executionConfig, f.workspace);
    services.push(reopened);
    await reopened.open();
    const status = await reopened.status(f.scope, seeded.runId);
    expect(status?.state).toBe('interrupted');
    expect(status?.nodes[0]?.state).toBe('interrupted');
    const attempts = await reopened.store.listAttempts(f.scope, seeded.runId, 'A');
    expect(attempts[0]?.state).toBe('interrupted');
    expect(attempts[0]?.exitCode).toBeUndefined();
  });

  it('Scenario I: degraded DMF queues one deterministic failure promotion and recovery replays it exactly once', async () => {
    const f = await rootFixture('i');
    const store = new ExecutionStore();
    await store.open({ dbPath: f.executionConfig.dbPath });
    const writer = new SwitchableMemoryWriter();
    const bridge = new ExecutionMemoryBridge(store, writer);
    const scope = f.scope satisfies MemoryScope;
    const run = await store.createRun(scope, {
      objective: 'degraded memory queue acceptance',
      continuityTaskId: 'task-memory-queue-acceptance',
      originRouteContextId: 'route-memory-queue-acceptance',
      maxConcurrency: 1,
    });
    await store.persistGraph(scope, run.runId, [{
      id: 'A',
      purpose: 'failed node A',
      command: "Write-Output 'bounded'; exit 9",
      cwd: f.work,
      dependsOn: [],
      timeoutMs: 5_000,
      continueOnFailure: false,
    }]);
    const logs = new ExecutionLogStore(f.executionConfig.logRoot);
    const paths = await logs.prepareAttempt(run.runId, 'A', 1);
    const attemptId = 'attempt-memory-queue-1';
    await store.createAttempt(scope, run.runId, 'A', attemptId, 1, paths);
    await store.completeAttempt(scope, terminal(run.runId, 'A', attemptId, 1, 'failed'));
    const event = await store.appendEvent(scope, run.runId, 'node.failed', {
      nodeId: 'A',
      attemptId,
      payload: { attemptNo: 1, exitCode: 9 },
    });

    expect(await bridge.handlePersistedEvent(scope, event)).toMatchObject({ queued: 1, promoted: 0 });
    expect(await store.countMemorySyncQueue(scope)).toBe(1);
    writer.healthy = true;
    expect(await bridge.replay(scope)).toMatchObject({ synced: 1, failed: 0 });
    expect(await store.countMemorySyncQueue(scope)).toBe(0);
    expect(writer.commits).toHaveLength(1);
    expect(await bridge.replay(scope)).toMatchObject({ synced: 0, failed: 0 });
    expect(writer.commits).toHaveLength(1);
    await store.close();
  });

  it('Stress: dependency scheduling and wake ordering remain deterministic across 10 repetitions', async () => {
    const f = await openControlled('stress', 4);
    for (let index = 0; index < 10; index++) {
      const created = await f.service.create(f.scope, {
        objective: `stress repetition ${index + 1}`,
        nodes: [
          { id: 'D', purpose: 'D', command: "Write-Output 'D'", cwd: f.work, dependsOn: ['A', 'B'] },
          { id: 'C', purpose: 'C', command: "Write-Output 'C'", cwd: f.work, dependsOn: ['A'] },
          { id: 'B', purpose: 'B', command: "Write-Output 'B'", cwd: f.work },
          { id: 'A', purpose: 'A', command: "Write-Output 'A'", cwd: f.work },
        ],
      });
      await f.service.start(f.scope, created.runId);
      const running = await f.service.status(f.scope, created.runId);
      const waiting = f.service.wait(
        f.scope,
        created.runId,
        running!.lastEventSequence,
        { eventTypes: ['node.succeeded'], nodeIds: ['A'] },
        2_000,
      );
      f.runner.complete(created.runId, 'A', 1, 'succeeded');
      const woke = await waiting;
      expect(woke.event).toMatchObject({ eventType: 'node.succeeded', nodeId: 'A' });
      expect(woke.state.nodes.find((node) => node.nodeId === 'B')?.state).toBe('running');
      await eventually(() => expect(f.runner.startedNodeIds(created.runId)).toEqual(['A', 'B', 'C']));
      f.runner.complete(created.runId, 'C', 1, 'succeeded');
      f.runner.complete(created.runId, 'B', 1, 'succeeded');
      await eventually(() => expect(f.runner.startedNodeIds(created.runId)).toEqual(['A', 'B', 'C', 'D']));
      f.runner.complete(created.runId, 'D', 1, 'succeeded');
      await eventually(async () => expect((await f.service.status(f.scope, created.runId))?.state).toBe('completed'));
      const events = await f.service.events(f.scope, created.runId, 0);
      expect(events.map((event) => event.sequence)).toEqual(events.map((_, eventIndex) => eventIndex + 1));
      expect(events.at(-1)?.eventType).toBe('run.completed');
    }
  }, 20_000);
});
