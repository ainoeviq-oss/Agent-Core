import { createHash } from 'node:crypto';
import { ContinuityPromoter, type ContinuityMemoryWriter, type ExecutionProcessCheckpointInput } from '../continuity/promoter.js';
import type { RecordMemoryEventRequest } from '../memory/store.js';
import type { MemoryCommitRequest, MemoryCommitResult, MemoryScope, MemoryStatus } from '../memory/types.js';
import type { ExecutionStore } from './store.js';
import type { ExecutionEventRecord } from './wake.js';

export interface ExecutionMemoryWriter extends ContinuityMemoryWriter {
  status(scope?: MemoryScope): Promise<MemoryStatus>;
  recordEvent(request: RecordMemoryEventRequest): Promise<unknown>;
}

type FailurePromotion = {
  type: 'failure';
  syncKey: string;
  runId: string;
  eventSequence: number;
  canonicalKey: string;
  value: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

type ArtifactPromotion = {
  type: 'artifact';
  syncKey: string;
  runId: string;
  eventSequence: number;
  canonicalKey: string;
  value: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

type ProcessCheckpointPromotion = {
  type: 'process_checkpoint';
  syncKey: string;
  runId: string;
  eventSequence: number;
  taskId: string;
  checkpoint: ExecutionProcessCheckpointInput;
};

export type ExecutionMemoryPromotion = FailurePromotion | ArtifactPromotion | ProcessCheckpointPromotion;

export interface ExecutionBridgeHandleResult {
  promoted: number;
  queued: number;
}

export interface ExecutionBridgeReplayResult {
  synced: number;
  failed: number;
}

function digest(value: string): string {
  return createHash('sha256').update(value.normalize('NFKC'), 'utf8').digest('hex').slice(0, 32);
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

function terminalRunEvent(eventType: string): boolean {
  return ['run.completed', 'run.failed', 'run.blocked', 'run.interrupted', 'run.cancelled'].includes(eventType);
}

export class ExecutionMemoryBridge {
  private readonly promoter: ContinuityPromoter;
  private readonly pending = new Set<Promise<unknown>>();

  constructor(
    readonly store: ExecutionStore,
    readonly memory: ExecutionMemoryWriter,
  ) {
    this.promoter = new ContinuityPromoter(memory);
  }

  dispatch(scope: MemoryScope, event: ExecutionEventRecord): void {
    const work = this.handlePersistedEvent(scope, event).catch(() => undefined);
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
  }

  async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  async flush(scope: MemoryScope): Promise<ExecutionBridgeReplayResult> {
    await this.drain();
    return this.replay(scope);
  }

  async handlePersistedEvent(scope: MemoryScope, event: ExecutionEventRecord): Promise<ExecutionBridgeHandleResult> {
    const promotions = await this.buildPromotions(scope, event);
    if (promotions.length === 0) return { promoted: 0, queued: 0 };

    let healthy = false;
    try {
      healthy = (await this.memory.status(scope)).healthy;
    } catch {
      healthy = false;
    }

    let promoted = 0;
    let queued = 0;
    for (const promotion of promotions) {
      if (healthy) {
        try {
          await this.apply(scope, promotion);
          promoted += 1;
          continue;
        } catch {
          healthy = false;
        }
      }
      await this.store.enqueueMemorySync(scope, promotion.runId, promotion.eventSequence, promotion.syncKey, promotion);
      queued += 1;
    }
    return { promoted, queued };
  }

  async replay(scope: MemoryScope): Promise<ExecutionBridgeReplayResult> {
    let healthy = false;
    try {
      healthy = (await this.memory.status(scope)).healthy;
    } catch {
      return { synced: 0, failed: 0 };
    }
    if (!healthy) return { synced: 0, failed: 0 };

    let synced = 0;
    let failed = 0;
    const queued = await this.store.listMemorySyncQueue(scope, 1000);
    for (const item of queued) {
      await this.store.markMemorySyncState(scope, item.queueId, 'syncing');
      try {
        await this.apply(scope, item.payload as unknown as ExecutionMemoryPromotion);
        await this.store.markMemorySyncState(scope, item.queueId, 'synced');
        synced += 1;
      } catch (error) {
        await this.store.markMemorySyncState(scope, item.queueId, 'failed', safeError(error));
        failed += 1;
      }
    }
    return { synced, failed };
  }

  private async buildPromotions(scope: MemoryScope, event: ExecutionEventRecord): Promise<ExecutionMemoryPromotion[]> {
    if (!['node.failed', 'node.succeeded'].includes(event.eventType) && !terminalRunEvent(event.eventType)) return [];
    const run = await this.store.getRun(scope, event.runId);
    if (!run) return [];
    const taskId = run.continuityTaskId;
    if (!taskId) return [];

    if (event.eventType === 'node.failed' || event.eventType === 'node.succeeded') {
      if (!event.nodeId) return [];
      const node = await this.store.getNode(scope, event.runId, event.nodeId);
      if (!node) return [];
      const attempts = await this.store.listAttempts(scope, event.runId, event.nodeId);
      const attempt = event.attemptId
        ? attempts.find((item) => item.attemptId === event.attemptId)
        : attempts.at(-1);
      if (!attempt) return [];
      const commandHash = digest(`${node.command}\n${node.cwd}`);
      const evidence = {
        taskId,
        runId: event.runId,
        nodeId: event.nodeId,
        attemptId: attempt.attemptId,
        attemptNo: attempt.attemptNo,
        commandHash,
        state: attempt.state,
        exitCode: attempt.exitCode ?? null,
        signal: attempt.signal ?? null,
        resultRef: attempt.resultPath,
        stdoutBytes: attempt.stdoutBytes,
        stderrBytes: attempt.stderrBytes,
        stdoutSha256: attempt.stdoutSha256 ?? null,
        stderrSha256: attempt.stderrSha256 ?? null,
        eventSequence: event.sequence,
      };
      if (event.eventType === 'node.failed') {
        return [{
          type: 'failure',
          syncKey: `execution:failure:${event.runId}:${event.nodeId}:${attempt.attemptNo}:${event.sequence}`,
          runId: event.runId,
          eventSequence: event.sequence,
          canonicalKey: `failure.execution.${commandHash}.${event.runId}.${attempt.attemptNo}`,
          value: { ...evidence, failureType: 'execution_node_failure' },
          metadata: { taskId, runId: event.runId, nodeId: event.nodeId, commandHash, eventSequence: event.sequence },
        }];
      }
      return [{
        type: 'artifact',
        syncKey: `execution:artifact:${event.runId}:${event.nodeId}:${attempt.attemptNo}:${event.sequence}`,
        runId: event.runId,
        eventSequence: event.sequence,
        canonicalKey: `execution.artifact.${event.runId}.${event.nodeId}.${attempt.attemptNo}`,
        value: { ...evidence, artifactType: 'execution_result_evidence' },
        metadata: { taskId, runId: event.runId, nodeId: event.nodeId, eventSequence: event.sequence },
      }];
    }

    const nodes = await this.store.getNodes(scope, event.runId);
    return [{
      type: 'process_checkpoint',
      syncKey: `execution:process-checkpoint:${event.runId}:${event.sequence}`,
      runId: event.runId,
      eventSequence: event.sequence,
      taskId,
      checkpoint: {
        runId: event.runId,
        eventSequence: event.sequence,
        state: run.state,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        evidence: nodes.map((node) => ({
          nodeId: node.nodeId,
          state: node.state,
          attemptCount: node.attemptCount,
        })),
      },
    }];
  }

  private async apply(scope: MemoryScope, promotion: ExecutionMemoryPromotion): Promise<MemoryCommitResult> {
    if (promotion.type === 'process_checkpoint') {
      return this.promoter.promoteExecutionProcessCheckpoint(scope, promotion.taskId, promotion.checkpoint);
    }
    const request: MemoryCommitRequest = {
      scope,
      canonicalKey: promotion.canonicalKey,
      kind: promotion.type === 'failure' ? 'failure' : 'artifact',
      value: promotion.value,
      importance: promotion.type === 'failure' ? 0.9 : 0.78,
      sourceType: promotion.type === 'failure' ? 'execution_failure' : 'execution_verified_evidence',
      sourceRef: promotion.runId,
      metadata: promotion.metadata,
      revisionAuthority: 'structured_state',
    };
    return this.memory.commit(request);
  }
}
