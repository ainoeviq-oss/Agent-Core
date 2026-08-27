import { randomUUID } from 'node:crypto';
import { ExecutionLogStore, type ExecutionResultMarker } from './log-store.js';
import type { ExecutionRunHandle, ExecutionRunOptions } from './runner.js';
import type { ExecutionScope, ExecutionRunState } from './types.js';
import { ExecutionStore, ExecutionStoreError, type ExecutionNodeRecord } from './store.js';
import type { ValidatedExecutionNode } from './dag.js';
import type { ExecutionEventJournal, ExecutionEventType } from './wake.js';

export interface ExecutionRunnerLike {
  start(
    runId: string,
    node: ValidatedExecutionNode,
    attemptId: string,
    attemptNo: number,
    options?: ExecutionRunOptions,
  ): Promise<ExecutionRunHandle>;
}

export interface ExecutionSchedulerStatus {
  runId: string;
  runningNodeIds: string[];
}

export interface ExecutionSchedulerOptions {
  logRoot: string;
  journal?: ExecutionEventJournal;
  onAttemptCompleted?: (scope: ExecutionScope, marker: ExecutionResultMarker) => Promise<void>;
}

interface ActiveExecution {
  handle: ExecutionRunHandle;
  settled: Promise<void>;
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
    expectedArtifacts: node.expectedArtifacts.map((artifact) => ({ ...artifact })),
  };
}

function nodeTerminalEvent(marker: ExecutionResultMarker): ExecutionEventType {
  if (marker.state === 'succeeded') return 'node.succeeded';
  if (marker.state === 'failed') return 'node.failed';
  if (marker.state === 'interrupted') return 'node.interrupted';
  return 'node.cancelled';
}

function runTerminalEvent(state: ExecutionRunState): ExecutionEventType | null {
  if (state === 'completed') return 'run.completed';
  if (state === 'failed') return 'run.failed';
  if (state === 'blocked') return 'run.blocked';
  if (state === 'interrupted') return 'run.interrupted';
  if (state === 'cancelled') return 'run.cancelled';
  return null;
}

export class ExecutionScheduler {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly active = new Map<string, ActiveExecution>();
  private readonly paths: ExecutionLogStore;
  private readonly journal?: ExecutionEventJournal;
  private readonly onAttemptCompleted?: (scope: ExecutionScope, marker: ExecutionResultMarker) => Promise<void>;
  private closing = false;

  constructor(
    readonly store: ExecutionStore,
    readonly runner: ExecutionRunnerLike,
    options: ExecutionSchedulerOptions,
  ) {
    this.paths = new ExecutionLogStore(options.logRoot);
    this.journal = options.journal;
    this.onAttemptCompleted = options.onAttemptCompleted;
  }

  async startRun(scope: ExecutionScope, runId: string): Promise<ExecutionSchedulerStatus> {
    return this.withRunLock(runId, async () => {
      if (this.closing) throw new Error('EXECUTION_SCHEDULER_CLOSING');
      const run = await this.store.getRun(scope, runId);
      if (!run) throw new ExecutionStoreError('EXECUTION_RUN_NOT_FOUND', 'Execution run was not found in authenticated scope');
      if (run.state === 'planned') {
        await this.store.setRunState(scope, runId, 'running');
        await this.emit(scope, runId, 'run.started', { payload: { previousState: 'planned' } });
      } else if (run.state !== 'running') {
        throw new ExecutionStoreError('EXECUTION_RUN_NOT_STARTABLE', `Run cannot start from state ${run.state}`);
      }
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
      const node = await this.store.getNode(scope, runId, nodeId);
      if (!node) throw new ExecutionStoreError('EXECUTION_NODE_NOT_FOUND', 'Execution node was not found');
      await this.store.resetNodeForRetry(scope, runId, nodeId);
      await this.emit(scope, runId, 'node.retry_started', {
        nodeId,
        payload: { previousState: node.state, nextAttemptNo: node.attemptCount + 1 },
      });
      await this.reconcileAndDispatch(scope, runId);
      return this.schedulerStatus(runId);
    });
  }

  async cancel(scope: ExecutionScope, runId: string, nodeId?: string): Promise<ExecutionSchedulerStatus> {
    const settlements: Promise<void>[] = [];
    await this.withRunLock(runId, async () => {
      if (this.closing) throw new Error('EXECUTION_SCHEDULER_CLOSING');
      const run = await this.store.getRun(scope, runId);
      if (!run) throw new ExecutionStoreError('EXECUTION_RUN_NOT_FOUND', 'Execution run was not found in authenticated scope');

      if (nodeId) {
        const node = await this.store.getNode(scope, runId, nodeId);
        if (!node) throw new ExecutionStoreError('EXECUTION_NODE_NOT_FOUND', 'Execution node was not found');
        if (node.state === 'cancelled') return;
        if (node.state === 'succeeded' || node.state === 'failed') {
          throw new ExecutionStoreError('EXECUTION_CANCEL_NOT_ALLOWED', `Node ${nodeId} cannot be cancelled from state ${node.state}`);
        }
        const active = this.active.get(this.key(runId, nodeId));
        if (active) {
          active.handle.terminate('cancelled');
          settlements.push(active.settled);
          return;
        }
        await this.store.setNodeState(scope, runId, nodeId, 'cancelled');
        await this.emit(scope, runId, 'node.cancelled', { nodeId, payload: { reason: 'explicit_cancel' } });
        await this.reconcileAndDispatch(scope, runId);
        return;
      }

      if (run.state === 'cancelled') return;
      const nodes = await this.store.getNodes(scope, runId);
      for (const node of nodes) {
        const active = this.active.get(this.key(runId, node.nodeId));
        if (active) {
          active.handle.terminate('cancelled');
          settlements.push(active.settled);
          continue;
        }
        if (node.state === 'queued' || node.state === 'ready' || node.state === 'blocked') {
          await this.store.setNodeState(scope, runId, node.nodeId, 'cancelled');
          await this.emit(scope, runId, 'node.cancelled', {
            nodeId: node.nodeId,
            payload: { reason: 'explicit_run_cancel' },
          });
        }
      }
    });

    if (settlements.length > 0) await Promise.allSettled(settlements);

    return this.withRunLock(runId, async () => {
      if (nodeId) {
        await this.reconcileAndDispatch(scope, runId);
        return this.schedulerStatus(runId);
      }
      const current = await this.store.getRun(scope, runId);
      if (!current) throw new ExecutionStoreError('EXECUTION_RUN_NOT_FOUND', 'Execution run was not found in authenticated scope');
      if (current.state !== 'cancelled') {
        await this.store.setRunState(scope, runId, 'cancelled');
        await this.emit(scope, runId, 'run.cancelled', { payload: { previousState: current.state } });
      }
      return this.schedulerStatus(runId);
    });
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const active = [...this.active.values()];
    for (const execution of active) execution.handle.terminate('interrupted');
    await Promise.allSettled(active.map((execution) => execution.settled));
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
    await this.emit(scope, runId, 'node.ready', {
      nodeId: node.nodeId,
      payload: { attemptNo, dependsOn: node.dependsOn },
    });
    await this.store.createAttempt(scope, runId, node.nodeId, attemptId, attemptNo, paths);

    let handle: ExecutionRunHandle;
    try {
      handle = await this.runner.start(runId, asValidated(node), attemptId, attemptNo, {
        onOutputAvailable: (payload) => this.emit(scope, runId, 'node.output_available', {
          nodeId: node.nodeId,
          attemptId,
          payload: { ...payload },
        }).then(() => undefined),
      });
      await this.store.setAttemptPid(scope, runId, attemptId, handle.pid);
      await this.emit(scope, runId, 'node.started', {
        nodeId: node.nodeId,
        attemptId,
        payload: { attemptNo, pid: handle.pid },
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      await this.store.failAttemptStart(scope, runId, node.nodeId, attemptId, failure);
      await this.emit(scope, runId, 'node.failed', {
        nodeId: node.nodeId,
        attemptId,
        payload: { attemptNo, startFailure: failure.message },
      });
      return;
    }

    const key = this.key(runId, node.nodeId);
    const settled = handle.completion.then(
      (marker) => this.withRunLock(runId, async () => {
        this.active.delete(key);
        await this.store.completeAttempt(scope, marker);
        if (this.onAttemptCompleted) {
          try { await this.onAttemptCompleted(scope, marker); } catch { /* derived observers never override process truth */ }
        }
        await this.emit(scope, runId, nodeTerminalEvent(marker), {
          nodeId: marker.nodeId,
          attemptId: marker.attemptId,
          payload: {
            attemptNo: marker.attemptNo,
            exitCode: marker.exitCode,
            signal: marker.signal,
            stdoutBytes: marker.stdoutBytes,
            stderrBytes: marker.stderrBytes,
          },
        });
        await this.reconcileAndDispatch(scope, runId);
      }),
      (error) => this.withRunLock(runId, async () => {
        this.active.delete(key);
        const failure = error instanceof Error ? error : new Error(String(error));
        await this.store.failAttemptStart(scope, runId, node.nodeId, attemptId, failure);
        await this.emit(scope, runId, 'node.failed', {
          nodeId: node.nodeId,
          attemptId,
          payload: { attemptNo, completionFailure: failure.message },
        });
        await this.reconcileAndDispatch(scope, runId);
      }),
    );
    this.active.set(key, { handle, settled });
    void settled.catch(() => undefined);
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
        await this.emit(scope, runId, 'node.blocked', {
          nodeId: node.nodeId,
          payload: { failedDependencies },
        });
      }
    }
  }

  private async updateRunTerminalState(scope: ExecutionScope, runId: string, nodes: ExecutionNodeRecord[]): Promise<void> {
    if (nodes.length === 0) return;
    let nextState: ExecutionRunState;
    if (nodes.some((node) => node.state === 'running' || node.state === 'queued' || node.state === 'ready')) {
      nextState = 'running';
    } else if (nodes.every((node) => node.state === 'succeeded')) {
      nextState = 'completed';
    } else if (nodes.some((node) => node.state === 'failed')) {
      nextState = 'failed';
    } else if (nodes.some((node) => node.state === 'interrupted')) {
      nextState = 'interrupted';
    } else if (nodes.some((node) => node.state === 'cancelled')) {
      nextState = 'cancelled';
    } else {
      nextState = 'blocked';
    }
    const current = await this.store.getRun(scope, runId);
    if (!current || current.state === nextState) return;
    await this.store.setRunState(scope, runId, nextState);
    const eventType = runTerminalEvent(nextState);
    if (eventType) await this.emit(scope, runId, eventType, { payload: { previousState: current.state } });
  }

  private async emit(
    scope: ExecutionScope,
    runId: string,
    eventType: ExecutionEventType,
    options: { nodeId?: string; attemptId?: string; payload?: Record<string, unknown> } = {},
  ): Promise<void> {
    if (this.journal) await this.journal.record(scope, runId, eventType, options);
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
