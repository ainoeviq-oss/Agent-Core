import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ExecutionLogStore, type ExecutionResultMarker } from '../src/execution/log-store.js';
import type { ExecutionRunHandle } from '../src/execution/runner.js';
import { ExecutionCommandRunner } from '../src/execution/runner.js';
import { ExecutionService } from '../src/execution/service.js';
import type { ExecutionRunnerLike } from '../src/execution/scheduler.js';
import type { ValidatedExecutionNode } from '../src/execution/dag.js';
import type { ExecutionScope } from '../src/execution/types.js';
import { WorkspacePolicy } from '../src/runtime/workspace.js';
import { retryMarkerCommand } from './helpers/platform-command.js';

const roots: string[] = [];

async function fixture(label: string, runner?: ExecutionRunnerLike, maxConcurrency = 4) {
  const base = process.env.TEMP || process.env.TMP || os.tmpdir();
  const root = await mkdtemp(path.join(base, `agent-core-execution-scheduler-${label}-`));
  roots.push(root);
  const work = path.join(root, 'work');
  await mkdir(work, { recursive: true });
  const baseConfig = loadConfig({}, root).execution;
  const config = {
    ...baseConfig,
    enabled: true,
    dbPath: path.join(root, 'runtime', 'execution', 'scheduler.sqlite'),
    logRoot: path.join(root, 'runtime', 'execution', 'runs'),
    maxConcurrency,
  };
  const workspace = new WorkspacePolicy([root]);
  const service = new ExecutionService(config, workspace, runner ? { runner } : undefined);
  await service.open();
  return { root, work, config, workspace, service, scope: { principalId: 'principal-a', projectId: root } satisfies ExecutionScope };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function marker(runId: string, nodeId: string, attemptId: string, attemptNo: number, state: ExecutionResultMarker['state']): ExecutionResultMarker {
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
  private pending = new Map<string, { resolve(value: ExecutionResultMarker): void; reject(error: Error): void }>();

  async start(runId: string, node: ValidatedExecutionNode, attemptId: string, attemptNo: number): Promise<ExecutionRunHandle> {
    this.starts.push({ runId, node, attemptId, attemptNo });
    let resolve!: (value: ExecutionResultMarker) => void;
    let reject!: (error: Error) => void;
    const completion = new Promise<ExecutionResultMarker>((res, rej) => { resolve = res; reject = rej; });
    this.pending.set(`${runId}/${node.id}/${attemptNo}`, { resolve, reject });
    return {
      pid: 10_000 + this.starts.length,
      completion,
      terminate: (state = 'cancelled') => resolve(marker(runId, node.id, attemptId, attemptNo, state)),
    };
  }

  complete(runId: string, nodeId: string, attemptNo: number, state: ExecutionResultMarker['state']) {
    const key = `${runId}/${nodeId}/${attemptNo}`;
    const pending = this.pending.get(key);
    if (!pending) throw new Error(`No pending runner handle: ${key}`);
    const started = this.starts.find((item) => item.runId === runId && item.node.id === nodeId && item.attemptNo === attemptNo)!;
    pending.resolve(marker(runId, nodeId, started.attemptId, attemptNo, state));
    this.pending.delete(key);
  }

  startedNodeIds(): string[] {
    return this.starts.map((item) => item.node.id);
  }
}

async function eventually(assertion: () => void | Promise<void>, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try { await assertion(); return; }
    catch (error) { lastError = error; await new Promise((resolve) => setImmediate(resolve)); }
  }
  throw lastError;
}

describe('concurrent dependency-aware execution scheduler', () => {
  it('launches independent A/B concurrently and starts C after A succeeds while B is still running; D waits for A+B', async () => {
    const runner = new ControlledRunner();
    const f = await fixture('unlock', runner, 4);
    try {
      const created = await f.service.create(f.scope, {
        objective: 'A/B/C/D dependency fixture',
        nodes: [
          { id: 'D', purpose: 'D', command: "Write-Output 'D'", cwd: f.work, dependsOn: ['A', 'B'] },
          { id: 'C', purpose: 'C', command: "Write-Output 'C'", cwd: f.work, dependsOn: ['A'] },
          { id: 'B', purpose: 'B', command: "Write-Output 'B'", cwd: f.work },
          { id: 'A', purpose: 'A', command: "Write-Output 'A'", cwd: f.work },
        ],
      });
      expect(created.state).toBe('planned');
      expect(created.nodes.map((item: any) => item.nodeId)).toEqual(['A', 'B', 'C', 'D']);

      await f.service.start(f.scope, created.runId);
      expect(runner.startedNodeIds()).toEqual(['A', 'B']);
      let status = await f.service.status(f.scope, created.runId);
      expect(status?.nodes.filter((item: any) => item.state === 'running').map((item: any) => item.nodeId).sort()).toEqual(['A', 'B']);

      runner.complete(created.runId, 'A', 1, 'succeeded');
      await eventually(() => expect(runner.startedNodeIds()).toEqual(['A', 'B', 'C']));
      status = await f.service.status(f.scope, created.runId);
      expect(status?.nodes.find((item: any) => item.nodeId === 'B')?.state).toBe('running');
      expect(status?.nodes.find((item: any) => item.nodeId === 'C')?.state).toBe('running');
      expect(status?.nodes.find((item: any) => item.nodeId === 'D')?.state).toBe('queued');

      runner.complete(created.runId, 'C', 1, 'succeeded');
      await new Promise((resolve) => setImmediate(resolve));
      expect(runner.startedNodeIds()).toEqual(['A', 'B', 'C']);

      runner.complete(created.runId, 'B', 1, 'succeeded');
      await eventually(() => expect(runner.startedNodeIds()).toEqual(['A', 'B', 'C', 'D']));
      runner.complete(created.runId, 'D', 1, 'succeeded');
      await eventually(async () => {
        const current = await f.service.status(f.scope, created.runId);
        expect(current?.state).toBe('completed');
      });
    } finally {
      await f.service.close();
    }
  });

  it('keeps unrelated B running after A fails and blocks only hard dependents of A', async () => {
    const runner = new ControlledRunner();
    const f = await fixture('failure', runner, 3);
    try {
      const created = await f.service.create(f.scope, {
        objective: 'failure isolation fixture',
        nodes: [
          { id: 'C', purpose: 'C', command: "Write-Output 'C'", cwd: f.work, dependsOn: ['A'] },
          { id: 'B', purpose: 'B', command: "Write-Output 'B'", cwd: f.work },
          { id: 'A', purpose: 'A', command: "Write-Output 'A'", cwd: f.work },
        ],
      });
      await f.service.start(f.scope, created.runId);
      expect(runner.startedNodeIds()).toEqual(['A', 'B']);

      runner.complete(created.runId, 'A', 1, 'failed');
      await eventually(async () => {
        const status = await f.service.status(f.scope, created.runId);
        expect(status?.nodes.find((item: any) => item.nodeId === 'A')?.state).toBe('failed');
        expect(status?.nodes.find((item: any) => item.nodeId === 'B')?.state).toBe('running');
        expect(status?.nodes.find((item: any) => item.nodeId === 'C')?.state).toBe('blocked');
      });
      expect(runner.startedNodeIds()).toEqual(['A', 'B']);

      runner.complete(created.runId, 'B', 1, 'succeeded');
      await eventually(async () => expect((await f.service.status(f.scope, created.runId))?.state).toBe('failed'));
    } finally {
      await f.service.close();
    }
  });

  it('never exceeds the configured max concurrency and fills newly available slots deterministically', async () => {
    const runner = new ControlledRunner();
    const f = await fixture('bound', runner, 2);
    try {
      const created = await f.service.create(f.scope, {
        objective: 'max concurrency fixture',
        maxConcurrency: 2,
        nodes: ['A', 'B', 'C', 'D'].map((id) => ({ id, purpose: id, command: `Write-Output '${id}'`, cwd: f.work })),
      });
      await f.service.start(f.scope, created.runId);
      expect(runner.startedNodeIds()).toEqual(['A', 'B']);

      runner.complete(created.runId, 'A', 1, 'succeeded');
      await eventually(() => expect(runner.startedNodeIds()).toEqual(['A', 'B', 'C']));
      let status = await f.service.status(f.scope, created.runId);
      expect(status?.nodes.filter((item: any) => item.state === 'running')).toHaveLength(2);

      runner.complete(created.runId, 'B', 1, 'succeeded');
      await eventually(() => expect(runner.startedNodeIds()).toEqual(['A', 'B', 'C', 'D']));
      status = await f.service.status(f.scope, created.runId);
      expect(status?.nodes.filter((item: any) => item.state === 'running')).toHaveLength(2);

      runner.complete(created.runId, 'C', 1, 'succeeded');
      runner.complete(created.runId, 'D', 1, 'succeeded');
      await eventually(async () => expect((await f.service.status(f.scope, created.runId))?.state).toBe('completed'));
    } finally {
      await f.service.close();
    }
  });

  it('explicit retry creates attempt 2 and preserves factual attempt 1 evidence', async () => {
    const f = await fixture('retry');
    try {
      const markerPath = path.join(f.work, 'retry.marker');
      const command = retryMarkerCommand(markerPath);
      const created = await f.service.create(f.scope, {
        objective: 'explicit retry fixture',
        nodes: [{ id: 'A', purpose: 'A retry', command, cwd: f.work }],
      });
      await f.service.start(f.scope, created.runId);
      await eventually(async () => expect((await f.service.status(f.scope, created.runId))?.nodes[0]?.state).toBe('failed'), 5000);

      const logStore = new ExecutionLogStore(f.config.logRoot);
      const attempt1 = await logStore.readResult(created.runId, 'A', 1);
      expect(attempt1).toMatchObject({ state: 'failed', exitCode: 9, attemptNo: 1 });

      await f.service.retry(f.scope, created.runId, 'A');
      await eventually(async () => expect((await f.service.status(f.scope, created.runId))?.state).toBe('completed'), 5000);
      const attempt2 = await logStore.readResult(created.runId, 'A', 2);
      expect(attempt2).toMatchObject({ state: 'succeeded', exitCode: 0, attemptNo: 2 });
      expect(await logStore.readResult(created.runId, 'A', 1)).toEqual(attempt1);
      expect((await f.service.status(f.scope, created.runId))?.nodes[0]).toMatchObject({ state: 'succeeded', attemptCount: 2 });
    } finally {
      await f.service.close();
    }
  }, 10_000);

  it('binds ownership to principal/project and RuntimeServices exposes the same ExecutionService facade without enabling live rollout', async () => {
    const f = await fixture('scope');
    try {
      const created = await f.service.create(f.scope, {
        objective: 'scope fixture',
        nodes: [{ id: 'A', purpose: 'A', command: "Write-Output 'A'", cwd: f.work }],
      });
      expect(await f.service.status({ principalId: 'other', projectId: f.root }, created.runId)).toBeNull();
      expect(await f.service.status({ principalId: 'principal-a', projectId: `${f.root}-other` }, created.runId)).toBeNull();
    } finally {
      await f.service.close();
    }
  });
});
