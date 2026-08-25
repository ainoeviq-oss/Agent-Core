import { createHash, randomUUID } from 'node:crypto';
import type { MemoryWorkerSqlOperation } from './db-worker.js';
import type { MemoryLifecycle } from './lifecycle.js';
import type { MemoryRetriever } from './retriever.js';
import type {
  MemoryPreflightRequest,
  MemoryPreflightResult,
  MemorySearchHit,
} from './types.js';
import type { MemoryWorkerClient } from './worker-client.js';

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`;
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function buildQueryText(request: MemoryPreflightRequest): string {
  return [request.task.trim(), request.context?.trim()]
    .filter((value): value is string => Boolean(value))
    .join('\n');
}

function conflictProjection(value: {
  conflictId: string;
  leftMemoryId: string;
  rightMemoryId: string;
  conflictType: string;
  status: 'open' | 'resolved';
  evidence: Record<string, unknown>;
  createdAt: number;
  resolvedAt?: number;
}): Record<string, unknown> {
  return {
    conflictId: value.conflictId,
    leftMemoryId: value.leftMemoryId,
    rightMemoryId: value.rightMemoryId,
    conflictType: value.conflictType,
    status: value.status,
    evidence: value.evidence,
    createdAt: value.createdAt,
    ...(value.resolvedAt === undefined ? {} : { resolvedAt: value.resolvedAt }),
  };
}

function isHardGuardrail(hit: MemorySearchHit): boolean {
  return hit.kind === 'guardrail' && hit.state === 'active' && hit.enforcement === 'hard';
}

export function createDisabledPreflightResult(request: MemoryPreflightRequest): MemoryPreflightResult {
  const queryText = buildQueryText(request);
  return {
    contextId: randomUUID(),
    queryText,
    snapshotHash: hashText(stableJson({ queryText, recalled: [] })),
    recalled: [],
    blocking: { blocked: false, guardrailMemoryIds: [], reasons: [] },
    blockingGuardrails: [],
    openConflicts: [],
    priorFailures: [],
    relatedDecisions: [],
    expiresAt: request.expiresAt,
  };
}

export class MemoryPreflightEngine {
  constructor(
    readonly client: MemoryWorkerClient,
    readonly retriever: MemoryRetriever,
    readonly lifecycle: MemoryLifecycle,
  ) {}

  async run(request: MemoryPreflightRequest): Promise<MemoryPreflightResult> {
    if (!request.scope.principalId?.trim()) throw new Error('Memory preflight requires principalId');
    if (!request.routeContextId?.trim()) throw new Error('Memory preflight requires routeContextId');
    if (!request.task?.trim()) throw new Error('Memory preflight requires a task');
    if (!Number.isFinite(request.expiresAt) || request.expiresAt <= Date.now()) {
      throw new Error('Memory preflight expiresAt must be in the future');
    }

    const queryText = buildQueryText(request);
    const recall = await this.retriever.search({
      scope: request.scope,
      query: queryText,
    });
    const openConflicts = await this.lifecycle.listOpenConflicts(request.scope);
    const blockingGuardrails = recall.hits.filter(isHardGuardrail);
    const priorFailures = recall.hits.filter((hit) => hit.kind === 'failure');
    const relatedDecisions = recall.hits.filter((hit) => hit.kind === 'decision');
    const blocking = {
      blocked: blockingGuardrails.length > 0,
      guardrailMemoryIds: blockingGuardrails.map((hit) => hit.memoryId),
      reasons: blockingGuardrails.map((hit) => `${hit.memoryId}:${hit.revisionId}:${hit.canonicalKey}`),
    };
    const contextId = randomUUID();
    const result: MemoryPreflightResult = {
      contextId,
      queryText,
      snapshotHash: recall.snapshotHash,
      recalled: recall.hits,
      blocking,
      blockingGuardrails,
      openConflicts: openConflicts.map(conflictProjection),
      priorFailures,
      relatedDecisions,
      expiresAt: request.expiresAt,
    };

    const now = Date.now();
    const operations: MemoryWorkerSqlOperation[] = [{
      kind: 'run',
      sql: `INSERT INTO memory_contexts(
        id, principal_id, route_context_id, query_text, query_hash, result_json, blocking_json, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        contextId,
        request.scope.principalId,
        request.routeContextId,
        queryText,
        hashText(queryText),
        stableJson({
          ...result,
          routeMetadata: request.routeMetadata ?? {},
        }),
        stableJson(blocking),
        now,
        request.expiresAt,
      ],
    }];

    recall.hits.forEach((hit, index) => {
      operations.push({
        kind: 'run',
        sql: `INSERT INTO memory_access_log(memory_id, context_id, rank, score, reason_json, accessed_at)
              VALUES (?, ?, ?, ?, ?, ?)`,
        params: [
          hit.memoryId,
          contextId,
          index + 1,
          hit.whyMatched.finalScore,
          stableJson(hit.whyMatched),
          now,
        ],
      });
    });
    await this.client.transaction(operations);
    return result;
  }
}
