import { randomUUID } from 'node:crypto';
import { ExecutionLogStore, type ExecutionResultMarker } from './log-store.js';
import type { ExecutionRunHandle } from './runner.js';
import type { ExecutionScope } from './types.js';
import { ExecutionStore, ExecutionStoreError, type ExecutionNodeRecord } from './store.js';
import type { ValidatedExecutionNode } from './dag.js';

export interface ExecutionRunnerLike {
  start(runId: string, node: ValidatedExecutionNode, attemptId: string, attemptNo: number): Promise<ExecutionRunHandle>;
}

export interface ExecutionSchedulerStatus {
  runId: string;
  runningNodeIds: string[];
}

export interface ExecutionSchedulerOptions {
  logRoot: string;
}

const FAILED_DEPENDENCY_STATES = new Set(['failed', 'blocked', 'interrupted', 'cancelled']);

function asValidated(node: ExecutionNodeRecord): ValidatedExecutionNode {
  return {
    id: node.nodeId,
    purpose: node.purpose,
    command: node.command,
    cwd: node.cwd,
    dependsOn: [...node.dependsOn],
    timeoutMs: node.timeoutMs,
    continueOnFailure: node.continueOnFailure,
  };
}

export class ExecutionScheduler {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly active = new Map<string, ExecutionRunHandle>();
  private readonly paths: ExecutionLogStore;
  private closing = false;

  constructor(
    readonly store: ExecutionStore,
    readonly runner: ExecutionRunnerLike,
    options: ExecutionSchedulerOptions,
  ) {
    this.paths = new ExecutionLogStore(options.logRoot);
  }

  async startRun(scope: ExecutionScope, runId: string): Promise<ExecutionSchedulerStatus> {
    return this.withRunLock(runId, async () => {
      if (this.closing) throw new Error('EXECUTION_SCHEDULER_CLOSING');
      const run = await this.store.getRun(scope, runId);
      if (!run) throw new ExecutionStoreError('EXECUTION_RUN_NOT_FOUND', 'Execution run was not found in authenticated scope');
      if (run.state === 'planned') await this.store.setRunState(scope, runId, 'running');
      else if (run.state !== 'running') throw new ExecutionStoreError('EXECUTION_RUN_NOT_STARTABLE', `Run cannot start from state ${run.state}`);
      await this.reconcileAndDispatch(scope, runId);
      return this.schedulerStatus(runId);
    });
  }

  async retryNode(scope: ExecutionScope, runId: string, nodeId: string): Promise<ExecutionSchedulerStatus> {
    return this.withRunLock(runId, async () => {
      if (this.closing) throw new Error('EXECUTION_SCHEDULER_CLOSING');
      if (this.active.has(this.key(runId, nodeId))) {
        throw new ExecutionStoreError('EXECUTION_RETRY_RUNNING', 'A running node cannot be retried');
      }
      await this.store.resetNodeForRetry(scope, runId, nodeId);
      await this.reconcileAndDispatch(scope, runId);
      return this.schedulerStatus(runId);
    });
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const handles = [...this.active.values()];
    for (const handle of handles) handle.terminate('interrupted');
    await Promise.allSettled(handles.map((handle) => handle.completion));
    await Promise.allSettled([...this.locks.values()]);
  }

  private async reconcileAndDispatch(scope: ExecutionScope, runId: string): Promise<void> {
    await this.propagateBlocked(scope, runId);
    let run = await this.store.getRun(scope, runId);
    if (!run) throw new ExecutionStoreError('EXECUTION_RUN_NOT_FOUND', 'Execution run disappeared from authenticated scope');
    let nodes = await this.store.getNodes(scope, runId);

    if (run.state !== 'running') {
      await this.updateRunTerminalState(scope, runId, nodes);
      return;
    }

    const runningCount = nodes.filter((node) => node.state === 'running').length;
    let slots = Math.max(0, run.maxConcurrency - runningCount);
    if (slots > 0) {
      const byId = new Map(nodes.map((node) => [node.nodeId, node]));
      const ready = nodes
        .filter((node) => (node.state === 'queued' || node.state === 'ready')
          && node.dependsOn.every((dependencyId) => byId.get(dependencyId)?.state === 'succeeded'))
        .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
      for (const node of ready) {
        if (slots <= 0) break;
        await this.launchNode(scope, runId, node);
        slots -= 1;
      }
    }

    await this.propagateBlocked(scope, runId);
    run = (await this.store.getRun(scope, runId))!;
    nodes = await this.store.getNodes(scope, runId);
    if (run.state === 'running') await this.updateRunTerminalState(scope, runId, nodes);
  }

  private async launchNode(scope: ExecutionScope, runId: string, node: ExecutionNodeRecord): Promise<void> {
    const attemptNo = node.attemptCount + 1;
    const attemptId = randomUUID();
    const paths = this.paths.paths(runId, node.nodeId, attemptNo);
    await this.store.createAttempt(scope, runId, node.nodeId, attemptId, attemptNo, paths);

    let handle: ExecutionRunHandle;
    try {
      handle = await this.runner.start(runId, asValidated(node), attemptId, attemptNo);
      await this.store.setAttemptPid(scope, runId, attemptId, handle.pid);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      await this.store.failAttemptStart(scope, runId, node.nodeId, attemptId, failure);
      return;
    }

    const key = this.key(runId, node.nodeId);
    this.active.set(key, handle);
    handle.completion.then(
      (marker) => {
        void this.withRunLock(runId, async () => {
          this.active.delete(key);
          await this.store.completeAttempt(scope, marker);
          await this.reconcileAndDispatch(scope, runId);
        }).catch(() => undefined);
      },
      (error) => {
        void this.withRunLock(runId, async () => {
          this.active.delete(key);
          const failure = error instanceof Error ? error : new Error(String(error));
          await this.store.failAttemptStart(scope, runId, node.nodeId, attemptId, failure);
          await this.reconcileAndDispatch(scope, runId);
        }).catch(() => undefined);
      },
    );
  }

  private async propagateBlocked(scope: ExecutionScope, runId: string): Promise<void> {
    while (true) {
      const nodes = await this.store.getNodes(scope, runId);
      const byId = new Map(nodes.map((node) => [node.nodeId, node]));
      const blocked = nodes
        .filter((node) => (node.state === 'queued' || node.state === 'ready')
          && node.dependsOn.some((dependencyId) => FAILED_DEPENDENCY_STATES.has(byId.get(dependencyId)?.state ?? '')))
        .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
      if (blocked.length === 0) return;
      for (const node of blocked) {
        const failedDependencies = node.dependsOn.filter((dependencyId) => FAILED_DEPENDENCY_STATES.has(byId.get(dependencyId)?.state ?? ''));
        await this.store.setNodeState(scope, runId, node.nodeId, 'blocked', { failedDependencies });
      }
    }
  }

  private async updateRunTerminalState(scope: ExecutionScope, runId: string, nodes: ExecutionNodeRecord[]): Promise<void> {
    if (nodes.length === 0) return;
    if (nodes.some((node) => node.state === 'running' || node.state === 'queued' || node.state === 'ready')) {
      await this.store.setRunState(scope, runId, 'running');
      return;
    }
    if (nodes.every((node) => node.state === 'succeeded')) {
      await this.store.setRunState(scope, runId, 'completed');
      return;
    }
    if (nodes.some((node) => node.state === 'failed')) {
      await this.store.setRunState(scope, runId, 'failed');
      return;
    }
    if (nodes.some((node) => node.state === 'interrupted')) {
      await this.store.setRunState(scope, runId, 'interrupted');
      return;
    }
    if (nodes.some((node) => node.state === 'cancelled')) {
      await this.store.setRunState(scope, runId, 'cancelled');
      return;
    }
    if (nodes.some((node) => node.state === 'blocked')) {
      await this.store.setRunState(scope, runId, 'blocked');
    }
  }

  private schedulerStatus(runId: string): ExecutionSchedulerStatus {
    const prefix = `${runId}/`;
    return {
      runId,
      runningNodeIds: [...this.active.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length))
        .sort((left, right) => left.localeCompare(right)),
    };
  }

  private key(runId: string, nodeId: string): string {
    return `${runId}/${nodeId}`;
  }

  private async withRunLock<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.locks.set(runId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(runId) === tail) this.locks.delete(runId);
    }
  }
}

export type ExecutionTerminalCallback = (marker: ExecutionResultMarker) => void;
