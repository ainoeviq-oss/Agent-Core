import { createHash } from 'node:crypto';
import type { MemoryCommitRequest, MemoryCommitResult, MemoryScope } from '../memory/types.js';
import type { ContinuityCheckpointInput } from './types.js';

export interface ContinuityMemoryWriter {
  commit(request: MemoryCommitRequest): Promise<MemoryCommitResult>;
}

export interface ContinuityPromotionResult {
  decisions: number;
  artifacts: number;
  failures: number;
  memoryIds: string[];
}

export interface ExecutionProcessCheckpointInput {
  runId: string;
  eventSequence: number;
  state: string;
  startedAt?: number;
  finishedAt?: number;
  evidence: Array<{
    nodeId: string;
    state: string;
    attemptCount: number;
  }>;
}

function digest(value: string): string {
  return createHash('sha256').update(value.normalize('NFKC').trim(), 'utf8').digest('hex').slice(0, 24);
}

function sourceMetadata(taskId: string, checkpointId: string, routeContextId: string) {
  return { taskId, checkpointId, routeContextId, source: 'continuity_checkpoint' };
}

export class ContinuityPromoter {
  constructor(private readonly writer: ContinuityMemoryWriter) {}

  async promote(
    scope: MemoryScope,
    taskId: string,
    checkpointId: string,
    input: ContinuityCheckpointInput,
  ): Promise<ContinuityPromotionResult> {
    const result: ContinuityPromotionResult = { decisions: 0, artifacts: 0, failures: 0, memoryIds: [] };

    for (const decision of input.decisions ?? []) {
      const committed = await this.writer.commit({
        scope,
        canonicalKey: `continuity.decision.${taskId}.${digest(decision.key)}`,
        kind: 'decision',
        value: {
          taskId,
          checkpointId,
          key: decision.key,
          value: decision.value,
          reason: decision.reason,
        },
        importance: 0.85,
        sourceType: 'continuity_checkpoint',
        sourceRef: checkpointId,
        metadata: sourceMetadata(taskId, checkpointId, input.routeContextId),
        revisionAuthority: 'structured_state',
      });
      result.decisions += 1;
      result.memoryIds.push(committed.memoryId);
    }

    for (const artifact of input.artifacts ?? []) {
      const committed = await this.writer.commit({
        scope,
        canonicalKey: `continuity.artifact.${taskId}.${digest(artifact.path)}`,
        kind: 'artifact',
        value: {
          taskId,
          checkpointId,
          path: artifact.path,
          role: artifact.role,
          ...(artifact.hash ? { hash: artifact.hash } : {}),
        },
        importance: 0.8,
        sourceType: 'continuity_checkpoint',
        sourceRef: checkpointId,
        metadata: sourceMetadata(taskId, checkpointId, input.routeContextId),
        revisionAuthority: 'structured_state',
      });
      result.artifacts += 1;
      result.memoryIds.push(committed.memoryId);
    }

    if (input.status === 'failed') {
      const committed = await this.writer.commit({
        scope,
        canonicalKey: `continuity.failure.${taskId}`,
        kind: 'failure',
        value: {
          taskId,
          checkpointId,
          summary: input.summary,
          blockers: input.blockers ?? [],
          evidence: (input.evidence ?? []).map((item) => ({
            type: item.type,
            ref: item.ref,
            ...(item.result ? { result: item.result } : {}),
          })),
        },
        importance: 0.9,
        sourceType: 'continuity_checkpoint',
        sourceRef: checkpointId,
        metadata: sourceMetadata(taskId, checkpointId, input.routeContextId),
        revisionAuthority: 'structured_state',
      });
      result.failures = 1;
      result.memoryIds.push(committed.memoryId);
    }

    return result;
  }

  async promoteExecutionProcessCheckpoint(
    scope: MemoryScope,
    taskId: string,
    input: ExecutionProcessCheckpointInput,
  ): Promise<MemoryCommitResult> {
    return this.writer.commit({
      scope,
      canonicalKey: `continuity.process_checkpoint.${taskId}.${input.runId}.${input.eventSequence}`,
      kind: 'artifact',
      value: {
        taskId,
        runId: input.runId,
        eventSequence: input.eventSequence,
        state: input.state,
        checkpointType: 'execution_process',
        summary: 'execution process checkpoint',
        taskCompleted: false,
        ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
        ...(input.finishedAt === undefined ? {} : { finishedAt: input.finishedAt }),
        evidence: input.evidence,
      },
      importance: 0.82,
      sourceType: 'execution_process_checkpoint',
      sourceRef: input.runId,
      metadata: {
        taskId,
        runId: input.runId,
        eventSequence: input.eventSequence,
        taskCompleted: false,
      },
      revisionAuthority: 'structured_state',
    });
  }
}
