import type { ExecutionConfig } from '../config.js';
import type { WorkspacePolicy } from '../runtime/workspace.js';
import { validateExecutionDag, type ExecutionNodeSpec } from './dag.js';
import { ExecutionLogStore } from './log-store.js';
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
}

export class ExecutionService {
  readonly store: ExecutionStore;
  readonly wake: ExecutionWakeCoordinator;
  readonly journal: ExecutionEventJournal;
  readonly logs: ExecutionLogStore;
  readonly scheduler: ExecutionScheduler;
  private opened = false;
  private closed = false;

  constructor(
    readonly config: ExecutionConfig,
    readonly workspace: WorkspacePolicy,
    dependencies: ExecutionServiceDependencies = {},
  ) {
    this.store = dependencies.store ?? new ExecutionStore();
    this.wake = dependencies.wake ?? new ExecutionWakeCoordinator(this.store);
    this.journal = dependencies.journal ?? new ExecutionEventJournal(this.store, this.wake);
    this.logs = new ExecutionLogStore(config.logRoot);
    const runner = dependencies.runner ?? new ExecutionCommandRunner(this.logs);
    this.scheduler = new ExecutionScheduler(this.store, runner, { logRoot: config.logRoot, journal: this.journal });
  }

  async open(): Promise<void> {
    if (this.closed) throw new Error('EXECUTION_SERVICE_CLOSED');
    if (this.opened) return;
    if (!this.config.enabled) throw new Error('EXECUTION_DISABLED');
    await this.store.open({ dbPath: this.config.dbPath, busyTimeoutMs: this.config.busyTimeoutMs });
    this.opened = true;
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
      continuityTaskId: input.continuityTaskId,
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
    if (this.closed) return;
    this.closed = true;
    if (!this.opened) return;
    await this.scheduler.close();
    await this.store.close();
  }

  private assertReady(): void {
    if (!this.opened || this.closed) throw new Error('EXECUTION_SERVICE_NOT_OPEN');
  }
}
