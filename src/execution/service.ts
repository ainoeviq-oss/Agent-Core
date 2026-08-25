import { randomUUID } from 'node:crypto';
import type { ExecutionConfig } from '../config.js';
import type { ExecutionContinuitySummary } from '../continuity/snapshot.js';
import type { WorkspacePolicy } from '../runtime/workspace.js';
import { validateExecutionDag, type ExecutionNodeSpec } from './dag.js';
import { ExecutionLogStore } from './log-store.js';
import type { ExecutionMemoryBridge } from './memory-bridge.js';
import { ExecutionRecovery } from './recovery.js';
import { ExecutionCommandRunner } from './runner.js';
import { ExecutionScheduler, type ExecutionRunnerLike } from './scheduler.js';
import {
  ExecutionStore,
  ExecutionStoreError,
  type ExecutionNodeRecord,
  type ExecutionRunRecord,
} from './store.js';
import type { ExecutionScope } from './types.js';
import {
  ExecutionEventJournal,
  ExecutionWakeCoordinator,
  type ExecutionEventFilter,
  type ExecutionEventRecord,
} from './wake.js';

export interface CreateExecutionGraphInput {
  objective: string;
  continuityTaskId?: string;
  originRouteContextId?: string;
  nodes: ExecutionNodeSpec[];
  maxConcurrency?: number;
  metadata?: Record<string, unknown>;
}

export interface ExecutionRunView extends ExecutionRunRecord {
  nodes: ExecutionNodeRecord[];
}

export interface ExecutionWaitResult {
  event: ExecutionEventRecord | null;
  timedOut: boolean;
  lastEventSequence: number;
  state: ExecutionRunView;
}

export interface ExecutionServiceDependencies {
  store?: ExecutionStore;
  runner?: ExecutionRunnerLike;
  wake?: ExecutionWakeCoordinator;
  journal?: ExecutionEventJournal;
  memoryBridge?: ExecutionMemoryBridge;
}

export type ExecutionServiceState = 'disabled' | 'idle' | 'healthy' | 'degraded' | 'closing' | 'closed';

export interface ExecutionHealth {
  enabled: boolean;
  healthy: boolean;
  state: ExecutionServiceState;
  schemaVersion: number;
  dbPath: string;
  integrity: string;
  activeRuns: number;
  queuedSync: number;
  lastIntegrityCheckAt?: number;
}

export class ExecutionService {
  readonly store: ExecutionStore;
  readonly wake: ExecutionWakeCoordinator;
  readonly journal: ExecutionEventJournal;
  readonly logs: ExecutionLogStore;
  readonly scheduler: ExecutionScheduler;
  readonly memoryBridge?: ExecutionMemoryBridge;
  private unsubscribeBridge?: () => void;
  private opened = false;
  private closed = false;
  private state: ExecutionServiceState;
  private degradedReason?: string;

  constructor(
    readonly config: ExecutionConfig,
    readonly workspace: WorkspacePolicy,
    dependencies: ExecutionServiceDependencies = {},
  ) {
    this.state = config.enabled ? 'idle' : 'disabled';
    this.store = dependencies.store ?? new ExecutionStore();
    this.wake = dependencies.wake ?? new ExecutionWakeCoordinator(this.store);
    this.journal = dependencies.journal ?? new ExecutionEventJournal(this.store, this.wake);
    this.logs = new ExecutionLogStore(config.logRoot);
    this.memoryBridge = dependencies.memoryBridge;
    if (this.memoryBridge) {
      this.unsubscribeBridge = this.journal.subscribe((scope, event) => {
        this.memoryBridge!.dispatch(scope, event);
      });
    }
    const runner = dependencies.runner ?? new ExecutionCommandRunner(this.logs);
    this.scheduler = new ExecutionScheduler(this.store, runner, { logRoot: config.logRoot, journal: this.journal });
  }

  get currentState(): ExecutionServiceState {
    return this.state;
  }

  async open(): Promise<void> {
    if (this.closed || this.state === 'closed') throw new Error('EXECUTION_SERVICE_CLOSED');
    if (this.opened && this.state === 'healthy') return;
    if (!this.config.enabled) {
      this.state = 'disabled';
      throw new Error('EXECUTION_DISABLED');
    }
    if (this.state === 'degraded') throw new Error(`EXECUTION_DEGRADED:${this.degradedReason ?? 'unknown'}`);
    try {
      await this.store.open({ dbPath: this.config.dbPath, busyTimeoutMs: this.config.busyTimeoutMs });
      const recovery = new ExecutionRecovery(this.store, this.logs);
      await recovery.reconcile();
      this.opened = true;
      this.state = 'healthy';
      this.degradedReason = undefined;
    } catch (error) {
      this.opened = false;
      this.state = 'degraded';
      this.degradedReason = error instanceof Error ? error.message : String(error);
      try { await this.store.close(); } catch {}
      throw error;
    }
  }

  async health(scope?: ExecutionScope): Promise<ExecutionHealth> {
    if (!this.config.enabled || this.state === 'disabled') {
      return { enabled: false, healthy: false, state: 'disabled', schemaVersion: 1, dbPath: this.config.dbPath, integrity: 'disabled', activeRuns: 0, queuedSync: 0 };
    }
    if (this.state === 'idle') {
      try { await this.open(); } catch {}
    }
    if (this.state !== 'healthy') {
      return { enabled: true, healthy: false, state: this.state, schemaVersion: 1, dbPath: this.config.dbPath, integrity: `degraded:${this.degradedReason ?? this.state}`, activeRuns: 0, queuedSync: 0 };
    }
    try {
      const status = await this.store.status();
      let activeRuns = 0;
      let queuedSync = 0;
      if (scope) {
        activeRuns = (await this.store.listRuns(scope, 1000)).filter((run) => run.state === 'planned' || run.state === 'running').length;
        queuedSync = await this.store.countMemorySyncQueue(scope);
      } else {
        const counts = await this.store.systemCounts();
        activeRuns = counts.activeRuns;
        queuedSync = counts.queuedSync;
      }
      return {
        enabled: true,
        healthy: status.healthy,
        state: status.healthy ? 'healthy' : 'degraded',
        schemaVersion: status.schemaVersion,
        dbPath: status.dbPath,
        integrity: status.integrity,
        activeRuns,
        queuedSync,
        ...(status.lastIntegrityCheckAt ? { lastIntegrityCheckAt: status.lastIntegrityCheckAt } : {}),
      };
    } catch (error) {
      this.state = 'degraded';
      this.degradedReason = error instanceof Error ? error.message : String(error);
      return { enabled: true, healthy: false, state: 'degraded', schemaVersion: 1, dbPath: this.config.dbPath, integrity: `degraded:${this.degradedReason}`, activeRuns: 0, queuedSync: 0 };
    }
  }

  async create(scope: ExecutionScope, input: CreateExecutionGraphInput): Promise<ExecutionRunView> {
    this.assertReady();
    const requestedConcurrency = input.maxConcurrency ?? this.config.maxConcurrency;
    if (!Number.isInteger(requestedConcurrency) || requestedConcurrency < 1 || requestedConcurrency > this.config.maxConcurrency) {
      throw new ExecutionStoreError(
        'EXECUTION_CONCURRENCY_INVALID',
        `maxConcurrency must be between 1 and configured maximum ${this.config.maxConcurrency}`,
      );
    }
    const graph = await validateExecutionDag(input.nodes, { workspace: this.workspace, maxNodes: this.config.maxNodes });
    const run = await this.store.createRun(scope, {
      objective: input.objective,
      continuityTaskId: input.continuityTaskId ?? randomUUID(),
      originRouteContextId: input.originRouteContextId,
      maxConcurrency: requestedConcurrency,
      metadata: input.metadata,
    });
    try {
      await this.store.persistGraph(scope, run.runId, graph.nodes);
      await this.journal.record(scope, run.runId, 'run.created', {
        payload: { objective: run.objective, maxConcurrency: run.maxConcurrency, nodeCount: graph.nodes.length },
      });
      for (const node of graph.nodes) {
        await this.journal.record(scope, run.runId, 'node.queued', {
          nodeId: node.id,
          payload: { dependsOn: node.dependsOn, timeoutMs: node.timeoutMs },
        });
      }
    } catch (error) {
      await this.store.setRunState(scope, run.runId, 'failed').catch(() => undefined);
      throw error;
    }
    return (await this.status(scope, run.runId))!;
  }

  async start(scope: ExecutionScope, runId: string): Promise<ExecutionRunView> {
    this.assertReady();
    await this.scheduler.startRun(scope, runId);
    const view = await this.status(scope, runId);
    if (!view) throw new ExecutionStoreError('EXECUTION_RUN_NOT_FOUND', 'Execution run was not found in authenticated scope');
    return view;
  }

  async status(scope: ExecutionScope, runId: string): Promise<ExecutionRunView | null> {
    this.assertReady();
    const run = await this.store.getRun(scope, runId);
    if (!run) return null;
    const nodes = await this.store.getNodes(scope, runId);
    return { ...run, nodes };
  }

  async addNodes(scope: ExecutionScope, runId: string, nodes: ExecutionNodeSpec[]): Promise<ExecutionRunView> {
    this.assertReady();
    const current = await this.status(scope, runId);
    if (!current) throw new ExecutionStoreError('EXECUTION_RUN_NOT_FOUND', 'Execution run was not found in authenticated scope');
    if (current.state !== 'planned' && current.state !== 'running') {
      throw new ExecutionStoreError('EXECUTION_RUN_NOT_EXTENSIBLE', `Nodes can only be added while run is planned or running, not ${current.state}`);
    }

    const existingSpecs: ExecutionNodeSpec[] = current.nodes.map((node) => ({
      id: node.nodeId,
      purpose: node.purpose,
      command: node.command,
      cwd: node.cwd,
      dependsOn: [...node.dependsOn],
      timeoutMs: node.timeoutMs,
      continueOnFailure: node.continueOnFailure,
    }));
    const graph = await validateExecutionDag([...existingSpecs, ...nodes], {
      workspace: this.workspace,
      maxNodes: this.config.maxNodes,
    });
    const requestedIds = new Set(nodes.map((node) => node.id.trim()));
    const validatedNew = graph.nodes.filter((node) => requestedIds.has(node.id));
    if (validatedNew.length !== nodes.length) {
      throw new ExecutionStoreError('EXECUTION_DYNAMIC_GRAPH_INVALID', 'Dynamic execution nodes did not validate one-to-one');
    }

    await this.store.appendGraphNodes(scope, runId, validatedNew);
    for (const node of validatedNew) {
      await this.journal.record(scope, runId, 'node.queued', {
        nodeId: node.id,
        payload: { dependsOn: node.dependsOn, timeoutMs: node.timeoutMs, dynamic: true },
      });
    }
    if (current.state === 'running') await this.scheduler.startRun(scope, runId);
    const view = await this.status(scope, runId);
    if (!view) throw new ExecutionStoreError('EXECUTION_RUN_NOT_FOUND', 'Execution run was not found in authenticated scope');
    return view;
  }

  async retry(scope: ExecutionScope, runId: string, nodeId: string): Promise<ExecutionRunView> {
    this.assertReady();
    await this.scheduler.retryNode(scope, runId, nodeId);
    const view = await this.status(scope, runId);
    if (!view) throw new ExecutionStoreError('EXECUTION_RUN_NOT_FOUND', 'Execution run was not found in authenticated scope');
    return view;
  }

  async cancel(scope: ExecutionScope, runId: string, nodeId?: string): Promise<ExecutionRunView> {
    this.assertReady();
    await this.scheduler.cancel(scope, runId, nodeId);
    const view = await this.status(scope, runId);
    if (!view) throw new ExecutionStoreError('EXECUTION_RUN_NOT_FOUND', 'Execution run was not found in authenticated scope');
    return view;
  }

  async events(
    scope: ExecutionScope,
    runId: string,
    afterSequence = 0,
    filters?: ExecutionEventFilter,
    limit = 1000,
  ): Promise<ExecutionEventRecord[]> {
    this.assertReady();
    return this.store.getEvents(scope, runId, afterSequence, filters, limit);
  }

  async wait(
    scope: ExecutionScope,
    runId: string,
    afterSequence: number,
    filters: ExecutionEventFilter | undefined,
    timeoutMs: number,
  ): Promise<ExecutionWaitResult> {
    this.assertReady();
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > this.config.waitMaxMs) {
      throw new Error(`EXECUTION_WAIT_TIMEOUT_INVALID:max ${this.config.waitMaxMs}`);
    }
    const event = await this.wake.waitForEvent(scope, runId, afterSequence, filters, timeoutMs);
    const state = await this.status(scope, runId);
    if (!state) throw new ExecutionStoreError('EXECUTION_RUN_NOT_FOUND', 'Execution run was not found in authenticated scope');
    return {
      event,
      timedOut: event === null,
      lastEventSequence: state.lastEventSequence,
      state,
    };
  }

  async readLog(
    scope: ExecutionScope,
    runId: string,
    nodeId: string,
    attemptNo: number,
    stream: 'stdout' | 'stderr',
    offset = 0,
    maxBytes = 64 * 1024,
  ) {
    this.assertReady();
    const run = await this.store.getRun(scope, runId);
    if (!run) throw new ExecutionStoreError('EXECUTION_RUN_NOT_FOUND', 'Execution run was not found in authenticated scope');
    const attempts = await this.store.listAttempts(scope, runId, nodeId);
    if (!attempts.some((attempt) => attempt.attemptNo === attemptNo)) {
      throw new ExecutionStoreError('EXECUTION_ATTEMPT_NOT_FOUND', 'Execution attempt was not found in authenticated scope');
    }
    return this.logs.readLog(runId, nodeId, attemptNo, stream, offset, maxBytes);
  }

  async continuitySummary(scope: ExecutionScope): Promise<ExecutionContinuitySummary> {
    this.assertReady();
    const runs = await this.store.listRuns(scope, 100);
    const compact = (run: ExecutionRunRecord) => ({
      runId: run.runId,
      ...(run.continuityTaskId ? { continuityTaskId: run.continuityTaskId } : {}),
      objective: run.objective.length <= 2_000 ? run.objective : `${run.objective.slice(0, 1_999)}…`,
      state: run.state as 'planned' | 'running' | 'interrupted',
      lastEventSequence: run.lastEventSequence,
      updatedAt: run.updatedAt,
    });
    const activeRuns = runs.filter((run) => run.state === 'planned' || run.state === 'running').slice(0, 10).map(compact);
    const interruptedRuns = runs.filter((run) => run.state === 'interrupted').slice(0, 10).map(compact);
    const terminal = runs.find((run) => ['completed', 'failed', 'blocked', 'interrupted', 'cancelled'].includes(run.state));
    return {
      activeRuns,
      interruptedRuns,
      lastExecutionCheckpoint: terminal ? {
        runId: terminal.runId,
        ...(terminal.continuityTaskId ? { continuityTaskId: terminal.continuityTaskId } : {}),
        state: terminal.state as 'completed' | 'failed' | 'blocked' | 'interrupted' | 'cancelled',
        lastEventSequence: terminal.lastEventSequence,
        ...(terminal.finishedAt ? { finishedAt: terminal.finishedAt } : {}),
        updatedAt: terminal.updatedAt,
      } : null,
    };
  }

  async recordOutputAvailable(
    scope: ExecutionScope,
    runId: string,
    nodeId: string,
    payload: Record<string, unknown> = {},
  ): Promise<ExecutionEventRecord | null> {
    this.assertReady();
    return this.journal.record(scope, runId, 'node.output_available', { nodeId, payload });
  }

  async close(): Promise<void> {
    if (this.closed || this.state === 'closed') return;
    this.closed = true;
    this.state = 'closing';
    if (this.opened) {
      await this.scheduler.close();
      if (this.memoryBridge) await this.memoryBridge.drain();
    }
    this.unsubscribeBridge?.();
    this.unsubscribeBridge = undefined;
    try { await this.store.close(); } catch {}
    this.opened = false;
    this.state = 'closed';
  }

  private assertReady(): void {
    if (!this.opened || this.closed || this.state !== 'healthy') throw new Error('EXECUTION_SERVICE_NOT_OPEN: execution service is not open');
  }
}
