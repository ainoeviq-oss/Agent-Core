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

export interface ExecutionServiceDependencies {
  store?: ExecutionStore;
  runner?: ExecutionRunnerLike;
}

export class ExecutionService {
  readonly store: ExecutionStore;
  readonly scheduler: ExecutionScheduler;
  private opened = false;
  private closed = false;

  constructor(
    readonly config: ExecutionConfig,
    readonly workspace: WorkspacePolicy,
    dependencies: ExecutionServiceDependencies = {},
  ) {
    this.store = dependencies.store ?? new ExecutionStore();
    const runner = dependencies.runner ?? new ExecutionCommandRunner(new ExecutionLogStore(config.logRoot));
    this.scheduler = new ExecutionScheduler(this.store, runner, { logRoot: config.logRoot });
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

  async retry(scope: ExecutionScope, runId: string, nodeId: string): Promise<ExecutionRunView> {
    this.assertReady();
    await this.scheduler.retryNode(scope, runId, nodeId);
    const view = await this.status(scope, runId);
    if (!view) throw new ExecutionStoreError('EXECUTION_RUN_NOT_FOUND', 'Execution run was not found in authenticated scope');
    return view;
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
