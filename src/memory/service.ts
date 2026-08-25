import { stat } from 'node:fs/promises';
import type { MemoryConfig } from '../config.js';
import {
  ContinuityStore,
  type ContinuityBeginTurnResult,
  type ContinuityCheckpointResult,
  type ContinuityFrontierRecord,
  type ContinuityTaskRecord,
} from '../continuity/store.js';
import type { ContinuityCapture, ContinuityCheckpointInput, ContinuityTurnState } from '../continuity/types.js';
import {
  createMemoryBackup,
  readLatestMemoryBackup,
  type MemoryBackupRecord,
} from './backup.js';
import { MemoryLifecycle } from './lifecycle.js';
import { MemoryLinker } from './linker.js';
import { MemoryPreflightEngine, createDisabledPreflightResult } from './preflight.js';
import { MemoryRetriever } from './retriever.js';
import { MEMORY_SCHEMA_VERSION } from './schema.js';
import {
  MemoryStore,
  type RecordMemoryEventRequest,
  type StoredMemoryRecord,
  type StoredMemoryRevision,
} from './store.js';
import type {
  MemoryCommitRequest,
  MemoryCommitResult,
  MemoryPreflightRequest,
  MemoryPreflightResult,
  MemoryReviseRequest,
  MemoryReviseResult,
  MemoryScope,
  MemorySearchRequest,
  MemorySearchResult,
  MemoryStatus,
} from './types.js';
import { MemoryWorkerClient } from './worker-client.js';

interface MemoryComponents {
  client: MemoryWorkerClient;
  store: MemoryStore;
  retriever: MemoryRetriever;
  lifecycle: MemoryLifecycle;
  linker: MemoryLinker;
  preflight: MemoryPreflightEngine;
  continuity: ContinuityStore;
}

export interface MemoryContextRecord {
  contextId: string;
  routeContextId: string;
  queryText: string;
  queryHash: string;
  resultJson: string;
  blockingJson: string;
  createdAt: number;
  expiresAt: number;
}

export interface MemoryProvenanceEvent {
  eventId: string;
  eventType: string;
  sourceType: string;
  sourceRef?: string;
  redactedText: string;
  metadata: Record<string, unknown>;
  createdAt: number;
}

export interface MemoryGetWithProvenanceResult {
  memory: StoredMemoryRecord;
  revisions: StoredMemoryRevision[];
  provenance: { events: MemoryProvenanceEvent[] };
}

export interface MemoryExplainView {
  memoryId: string;
  revisions: StoredMemoryRevision[];
  anchors: Array<{ value: string; type: string }>;
  edges: Array<{
    fromMemoryId: string;
    toMemoryId: string;
    relation: string;
    weight: number;
    evidenceEventId?: string;
  }>;
  sourceEvents: MemoryProvenanceEvent[];
  queryExplanation: MemorySearchResult['hits'][number] | null;
}

export interface MemoryExportView {
  items: StoredMemoryRecord[];
  revisions: StoredMemoryRevision[];
  events: MemoryProvenanceEvent[];
  conflicts: Array<Record<string, unknown>>;
  truncated: boolean;
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function scopeProject(scope: MemoryScope): string {
  return scope.projectId ?? '';
}

export type MemoryServiceState = 'disabled' | 'idle' | 'healthy' | 'degraded' | 'closed';

export class MemoryService {
  private components: MemoryComponents | undefined;
  private opening: Promise<MemoryComponents> | undefined;
  private state: MemoryServiceState;
  private degradedReason: string | undefined;
  private lastIntegrityCheckAt: number | undefined;
  private lastSuccessfulIntegrityCheckAt: number | undefined;
  private lastBackup: MemoryBackupRecord | undefined;

  constructor(readonly config: MemoryConfig) {
    this.state = config.enabled ? 'idle' : 'disabled';
  }

  get currentState(): MemoryServiceState {
    return this.state;
  }

  async beginContinuityTurn(
    scope: MemoryScope,
    routeContextId: string,
    task: string,
    context: string | undefined,
    capture: ContinuityCapture = {},
    expiresAt?: number,
  ): Promise<ContinuityBeginTurnResult> {
    const components = await this.requireComponents();
    return components.continuity.beginTurn(scope, routeContextId, task, context, capture, expiresAt);
  }

  async checkpointContinuity(
    scope: MemoryScope,
    taskId: string,
    turnId: string,
    input: ContinuityCheckpointInput,
  ): Promise<ContinuityCheckpointResult> {
    const components = await this.requireComponents();
    return components.continuity.checkpoint(scope, taskId, turnId, input);
  }

  async closeContinuityTurn(
    scope: MemoryScope,
    turnId: string,
    finalState: Exclude<ContinuityTurnState, 'open'>,
  ): Promise<void> {
    const components = await this.requireComponents();
    await components.continuity.closeTurn(scope, turnId, finalState);
  }

  async getContinuityTask(scope: MemoryScope, taskId: string): Promise<ContinuityTaskRecord | null> {
    if (!this.config.enabled) return null;
    const components = await this.requireComponents();
    return components.continuity.getTask(scope, taskId);
  }

  async listContinuityFrontier(scope: MemoryScope, limit = 5): Promise<ContinuityFrontierRecord[]> {
    if (!this.config.enabled) return [];
    const components = await this.requireComponents();
    return components.continuity.listFrontier(scope, limit);
  }
  async recordEvent(request: RecordMemoryEventRequest) {
    if (!this.config.enabled) return null;
    const components = await this.requireComponents();
    return components.store.recordEvent(request);
  }

  async commit(request: MemoryCommitRequest): Promise<MemoryCommitResult> {
    const components = await this.requireComponents();
    const result = await components.store.commitMemory(request);
    await components.linker.linkMemory(request.scope, result.memoryId);
    return result;
  }

  async revise(request: MemoryReviseRequest): Promise<MemoryReviseResult> {
    const components = await this.requireComponents();
    const result = await components.store.reviseMemory(request);
    await components.linker.linkMemory(request.scope, result.memoryId);
    return result;
  }

  async search(request: MemorySearchRequest): Promise<MemorySearchResult> {
    if (!this.config.enabled) {
      const result = createDisabledPreflightResult({
        scope: request.scope,
        routeContextId: 'disabled-search',
        task: request.query || 'disabled search',
        expiresAt: Date.now() + 1,
      });
      return { query: request.query, hits: [], graphTruncated: false, snapshotHash: result.snapshotHash };
    }
    const components = await this.requireComponents();
    return components.retriever.search(request);
  }

  async preflight(request: MemoryPreflightRequest): Promise<MemoryPreflightResult> {
    if (!this.config.enabled) return createDisabledPreflightResult(request);
    const components = await this.requireComponents();
    return components.preflight.run(request);
  }

  async openConflict(
    scope: MemoryScope,
    leftMemoryId: string,
    rightMemoryId: string,
    conflictType: string,
    evidence: Record<string, unknown>,
  ) {
    const components = await this.requireComponents();
    return components.lifecycle.openConflict(scope, leftMemoryId, rightMemoryId, conflictType, evidence);
  }

  async listOpenConflicts(scope: MemoryScope) {
    if (!this.config.enabled) return [];
    const components = await this.requireComponents();
    return components.lifecycle.listOpenConflicts(scope);
  }

  async getMemory(scope: MemoryScope, memoryId: string) {
    if (!this.config.enabled) return null;
    const components = await this.requireComponents();
    return components.store.getMemory(scope, memoryId);
  }

  async listRevisions(scope: MemoryScope, memoryId: string) {
    if (!this.config.enabled) return [];
    const components = await this.requireComponents();
    return components.store.listRevisions(scope, memoryId);
  }

  async getWithProvenance(scope: MemoryScope, memoryId: string): Promise<MemoryGetWithProvenanceResult | null> {
    if (!this.config.enabled) return null;
    const components = await this.requireComponents();
    const memory = await components.store.getMemory(scope, memoryId);
    if (!memory) return null;
    const revisions = await components.store.listRevisions(scope, memoryId);
    const sourceEventIds = [...new Set(revisions.map((revision) => revision.sourceEventId).filter((id): id is string => Boolean(id)))];
    const events = await this.loadProvenanceEvents(components.client, scope, sourceEventIds);
    return { memory, revisions, provenance: { events } };
  }

  async explain(scope: MemoryScope, memoryId: string, query?: string): Promise<MemoryExplainView | null> {
    if (!this.config.enabled) return null;
    const components = await this.requireComponents();
    const memory = await components.store.getMemory(scope, memoryId);
    if (!memory) return null;
    const revisions = await components.store.listRevisions(scope, memoryId);
    const anchors = await components.client.query<Record<string, unknown>>(
      `SELECT anchor, anchor_type
         FROM memory_anchors AS anchor_row
         JOIN memory_items AS item ON item.id = anchor_row.memory_id
        WHERE anchor_row.memory_id = ? AND item.principal_id = ? AND IFNULL(item.project_id, '') = ?
        ORDER BY anchor_type COLLATE BINARY, anchor COLLATE BINARY`,
      [memoryId, scope.principalId, scopeProject(scope)],
    );
    const edges = await components.client.query<Record<string, unknown>>(
      `SELECT edge.from_memory_id, edge.to_memory_id, edge.relation, edge.weight, edge.evidence_event_id
         FROM memory_edges AS edge
         JOIN memory_items AS left_item ON left_item.id = edge.from_memory_id
         JOIN memory_items AS right_item ON right_item.id = edge.to_memory_id
        WHERE (edge.from_memory_id = ? OR edge.to_memory_id = ?)
          AND left_item.principal_id = ? AND IFNULL(left_item.project_id, '') = ?
          AND right_item.principal_id = ? AND IFNULL(right_item.project_id, '') = ?
        ORDER BY edge.from_memory_id COLLATE BINARY, edge.to_memory_id COLLATE BINARY, edge.relation COLLATE BINARY`,
      [memoryId, memoryId, scope.principalId, scopeProject(scope), scope.principalId, scopeProject(scope)],
    );
    const eventIds = [...new Set([
      ...revisions.map((revision) => revision.sourceEventId),
      ...edges.map((edge) => edge.evidence_event_id == null ? undefined : String(edge.evidence_event_id)),
    ].filter((id): id is string => Boolean(id)))];
    const sourceEvents = await this.loadProvenanceEvents(components.client, scope, eventIds);
    let queryExplanation: MemoryExplainView['queryExplanation'] = null;
    if (query?.trim()) {
      const search = await components.retriever.search({
        scope,
        query,
        includeHistory: true,
        limit: Math.min(this.config.recallItemBudget, 100),
      });
      queryExplanation = search.hits.find((hit) => hit.memoryId === memoryId) ?? null;
    }
    return {
      memoryId,
      revisions,
      anchors: anchors.map((row) => ({ value: String(row.anchor), type: String(row.anchor_type) })),
      edges: edges.map((row) => ({
        fromMemoryId: String(row.from_memory_id),
        toMemoryId: String(row.to_memory_id),
        relation: String(row.relation),
        weight: Number(row.weight),
        ...(row.evidence_event_id == null ? {} : { evidenceEventId: String(row.evidence_event_id) }),
      })),
      sourceEvents,
      queryExplanation,
    };
  }

  async export(scope: MemoryScope, limit = 100): Promise<MemoryExportView> {
    if (!this.config.enabled) return { items: [], revisions: [], events: [], conflicts: [], truncated: false };
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('MEMORY_EXPORT_LIMIT_INVALID');
    const components = await this.requireComponents();
    const project = scopeProject(scope);
    const countRows = await components.client.query<Record<string, unknown>>(
      `SELECT count(*) AS count FROM memory_items WHERE principal_id = ? AND IFNULL(project_id, '') = ?`,
      [scope.principalId, project],
    );
    const totalItems = Number(countRows[0]?.count ?? 0);
    const itemRows = await components.client.query<Record<string, unknown>>(
      `SELECT item.id AS memory_id, item.principal_id, item.project_id, item.canonical_key, item.kind, item.state,
              item.importance, item.pinned, item.enforcement, item.created_at, item.updated_at,
              revision.id AS revision_id, revision.revision_no, revision.value_text, revision.value_json,
              revision.value_hash, revision.source_event_id
         FROM memory_items AS item
         JOIN memory_revisions AS revision ON revision.id = item.current_revision_id
        WHERE item.principal_id = ? AND IFNULL(item.project_id, '') = ?
        ORDER BY item.updated_at DESC, item.id COLLATE BINARY
        LIMIT ?`,
      [scope.principalId, project, limit],
    );
    const itemIds = itemRows.map((row) => String(row.memory_id));
    const items = itemRows.map((row) => ({
      memoryId: String(row.memory_id),
      revisionId: String(row.revision_id),
      revisionNo: Number(row.revision_no),
      principalId: String(row.principal_id),
      projectId: row.project_id == null ? undefined : String(row.project_id),
      canonicalKey: String(row.canonical_key),
      kind: String(row.kind) as StoredMemoryRecord['kind'],
      state: String(row.state) as StoredMemoryRecord['state'],
      importance: Number(row.importance),
      pinned: Number(row.pinned) === 1,
      enforcement: String(row.enforcement) as StoredMemoryRecord['enforcement'],
      valueText: String(row.value_text),
      valueJson: row.value_json == null ? undefined : String(row.value_json),
      valueHash: String(row.value_hash),
      sourceEventId: row.source_event_id == null ? undefined : String(row.source_event_id),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    })) satisfies StoredMemoryRecord[];
    const revisions: StoredMemoryRevision[] = [];
    for (const memoryId of itemIds) revisions.push(...await components.store.listRevisions(scope, memoryId));
    const eventLimit = Math.min(5000, Math.max(limit, limit * 10));
    const eventRows = await components.client.query<Record<string, unknown>>(
      `SELECT id, event_type, source_type, source_ref, redacted_text, metadata_json, created_at
         FROM memory_events
        WHERE principal_id = ? AND IFNULL(project_id, '') = ?
        ORDER BY created_at, id COLLATE BINARY
        LIMIT ?`,
      [scope.principalId, project, eventLimit],
    );
    const conflictRows = await components.client.query<Record<string, unknown>>(
      `SELECT conflict.id, conflict.left_memory_id, conflict.right_memory_id, conflict.conflict_type,
              conflict.status, conflict.evidence_json, conflict.created_at, conflict.resolved_at
         FROM memory_conflicts AS conflict
         JOIN memory_items AS left_item ON left_item.id = conflict.left_memory_id
        WHERE left_item.principal_id = ? AND IFNULL(left_item.project_id, '') = ?
        ORDER BY conflict.created_at, conflict.id COLLATE BINARY
        LIMIT ?`,
      [scope.principalId, project, Math.min(limit, 1000)],
    );
    return {
      items,
      revisions,
      events: eventRows.map((row) => ({
        eventId: String(row.id),
        eventType: String(row.event_type),
        sourceType: String(row.source_type),
        sourceRef: row.source_ref == null ? undefined : String(row.source_ref),
        redactedText: String(row.redacted_text),
        metadata: parseMetadata(row.metadata_json),
        createdAt: Number(row.created_at),
      })),
      conflicts: conflictRows.map((row) => ({
        conflictId: String(row.id),
        leftMemoryId: String(row.left_memory_id),
        rightMemoryId: String(row.right_memory_id),
        conflictType: String(row.conflict_type),
        status: String(row.status),
        evidence: parseMetadata(row.evidence_json),
        createdAt: Number(row.created_at),
        ...(row.resolved_at == null ? {} : { resolvedAt: Number(row.resolved_at) }),
      })),
      truncated: totalItems > limit,
    };
  }

  async forget(scope: MemoryScope, memoryId: string, reason: string): Promise<void> {
    const components = await this.requireComponents();
    await components.store.tombstoneMemory(scope, memoryId, reason);
  }

  async compact(scope: MemoryScope, now = Date.now()) {
    const components = await this.requireComponents();
    return components.lifecycle.compact(scope, now);
  }

  async backup(reason = 'manual'): Promise<MemoryBackupRecord> {
    const components = await this.requireComponents();
    const record = await createMemoryBackup(components.client, this.config.dbPath, reason);
    this.lastBackup = record;
    return record;
  }

  async getContext(scope: MemoryScope, contextId: string): Promise<MemoryContextRecord | null> {
    if (!this.config.enabled) return null;
    const components = await this.requireComponents();
    const rows = await components.client.query<Record<string, unknown>>(
      `SELECT id, route_context_id, query_text, query_hash, result_json, blocking_json, created_at, expires_at
         FROM memory_contexts
        WHERE id = ? AND principal_id = ? AND expires_at > ?
        LIMIT 1`,
      [contextId, scope.principalId, Date.now()],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      contextId: String(row.id),
      routeContextId: String(row.route_context_id),
      queryText: String(row.query_text),
      queryHash: String(row.query_hash),
      resultJson: String(row.result_json),
      blockingJson: String(row.blocking_json),
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
    };
  }

  async status(scope?: MemoryScope): Promise<MemoryStatus> {
    if (!this.config.enabled) {
      return {
        enabled: false,
        healthy: false,
        schemaVersion: MEMORY_SCHEMA_VERSION,
        dbPath: this.config.dbPath,
        counts: {},
        integrity: 'disabled',
      };
    }
    try {
      const components = await this.requireComponents();
      let counts: Record<string, unknown> | undefined;
      if (scope) {
        const project = scopeProject(scope);
        [counts] = await components.client.query<Record<string, unknown>>(
          `SELECT
            (SELECT count(*) FROM memory_items WHERE principal_id = ? AND IFNULL(project_id, '') = ? AND state = 'active') AS active_items,
            (SELECT count(*) FROM memory_revisions AS revision JOIN memory_items AS item ON item.id = revision.memory_id WHERE item.principal_id = ? AND IFNULL(item.project_id, '') = ?) AS revisions,
            (SELECT count(*) FROM memory_edges AS edge JOIN memory_items AS item ON item.id = edge.from_memory_id WHERE item.principal_id = ? AND IFNULL(item.project_id, '') = ?) AS edges,
            (SELECT count(*) FROM memory_conflicts AS conflict JOIN memory_items AS item ON item.id = conflict.left_memory_id WHERE item.principal_id = ? AND IFNULL(item.project_id, '') = ? AND conflict.status = 'open') AS open_conflicts,
            (SELECT count(*) FROM memory_items WHERE principal_id = ? AND IFNULL(project_id, '') = ? AND state = 'tombstoned') AS tombstones,
            (SELECT count(*) FROM memory_fts WHERE principal_id = ? AND IFNULL(project_id, '') = ?) AS fts_rows`,
          [
            scope.principalId, project,
            scope.principalId, project,
            scope.principalId, project,
            scope.principalId, project,
            scope.principalId, project,
            scope.principalId, project,
          ],
        );
      } else {
        [counts] = await components.client.query<Record<string, unknown>>(`SELECT
          (SELECT count(*) FROM memory_items WHERE state = 'active') AS active_items,
          (SELECT count(*) FROM memory_revisions) AS revisions,
          (SELECT count(*) FROM memory_edges) AS edges,
          (SELECT count(*) FROM memory_conflicts WHERE status = 'open') AS open_conflicts,
          (SELECT count(*) FROM memory_items WHERE state = 'tombstoned') AS tombstones,
          (SELECT count(*) FROM memory_fts) AS fts_rows`);
      }
      const integrity = await components.client.integrity();
      const checkedAt = Date.now();
      this.lastIntegrityCheckAt = checkedAt;
      if (integrity.ok) this.lastSuccessfulIntegrityCheckAt = checkedAt;
      this.lastBackup ??= await readLatestMemoryBackup(this.config.dbPath) ?? undefined;
      const dbBytes = await stat(this.config.dbPath).then((info) => info.size).catch(() => 0);
      return {
        enabled: true,
        healthy: integrity.ok,
        schemaVersion: MEMORY_SCHEMA_VERSION,
        dbPath: this.config.dbPath,
        counts: {
          ...Object.fromEntries(Object.entries(counts ?? {}).map(([key, value]) => [key, Number(value)])),
          db_bytes: dbBytes,
        },
        integrity: integrity.result,
        lastIntegrityCheckAt: this.lastIntegrityCheckAt,
        lastSuccessfulIntegrityCheckAt: this.lastSuccessfulIntegrityCheckAt,
        ...(this.lastBackup ? {
          lastBackupPath: this.lastBackup.backupPath,
          lastBackupAt: this.lastBackup.createdAt,
        } : {}),
      };
    } catch (error) {
      this.lastIntegrityCheckAt = Date.now();
      this.lastBackup ??= await readLatestMemoryBackup(this.config.dbPath) ?? undefined;
      return {
        enabled: true,
        healthy: false,
        schemaVersion: MEMORY_SCHEMA_VERSION,
        dbPath: this.config.dbPath,
        counts: {},
        integrity: `degraded:${error instanceof Error ? error.message : String(error)}`,
        lastIntegrityCheckAt: this.lastIntegrityCheckAt,
        lastSuccessfulIntegrityCheckAt: this.lastSuccessfulIntegrityCheckAt,
        ...(this.lastBackup ? {
          lastBackupPath: this.lastBackup.backupPath,
          lastBackupAt: this.lastBackup.createdAt,
        } : {}),
      };
    }
  }

  async close(): Promise<void> {
    if (this.state === 'closed') return;
    const opening = this.opening;
    if (opening) {
      try { await opening; } catch { /* degraded initialization is already recorded */ }
    }
    if (this.components) await this.components.store.close();
    this.state = 'closed';
  }

  private async loadProvenanceEvents(
    client: MemoryWorkerClient,
    scope: MemoryScope,
    eventIds: string[],
  ): Promise<MemoryProvenanceEvent[]> {
    if (eventIds.length === 0) return [];
    const uniqueIds = [...new Set(eventIds)].slice(0, 5000);
    const placeholders = uniqueIds.map(() => '?').join(',');
    const rows = await client.query<Record<string, unknown>>(
      `SELECT id, event_type, source_type, source_ref, redacted_text, metadata_json, created_at
         FROM memory_events
        WHERE principal_id = ? AND IFNULL(project_id, '') = ? AND id IN (${placeholders})
        ORDER BY created_at, id COLLATE BINARY`,
      [scope.principalId, scopeProject(scope), ...uniqueIds],
    );
    return rows.map((row) => ({
      eventId: String(row.id),
      eventType: String(row.event_type),
      sourceType: String(row.source_type),
      sourceRef: row.source_ref == null ? undefined : String(row.source_ref),
      redactedText: String(row.redacted_text),
      metadata: parseMetadata(row.metadata_json),
      createdAt: Number(row.created_at),
    }));
  }

  private async requireComponents(): Promise<MemoryComponents> {
    if (!this.config.enabled) throw new Error('MEMORY_DISABLED');
    if (this.state === 'closed') throw new Error('MEMORY_CLOSED');
    if (this.components && this.state === 'healthy') return this.components;
    if (this.state === 'degraded') throw new Error(`MEMORY_DEGRADED:${this.degradedReason ?? 'unknown'}`);
    if (this.opening) return this.opening;

    this.opening = this.openComponents();
    try {
      return await this.opening;
    } finally {
      this.opening = undefined;
    }
  }

  private async openComponents(): Promise<MemoryComponents> {
    const client = new MemoryWorkerClient();
    const store = new MemoryStore(client);
    const retriever = new MemoryRetriever(client, this.config);
    const lifecycle = new MemoryLifecycle(client, this.config);
    const linker = new MemoryLinker(client, {
      tokenOverlapJaccardThreshold: this.config.tokenOverlapJaccardThreshold,
      temporalNeighborWindowMs: this.config.temporalNeighborWindowMs,
      candidateCap: Math.min(512, this.config.seedCap),
    });
    const preflight = new MemoryPreflightEngine(client, retriever, lifecycle);
    const continuity = new ContinuityStore(client);
    const components = { client, store, retriever, lifecycle, linker, preflight, continuity };
    try {
      const opened = await store.open({ dbPath: this.config.dbPath, busyTimeoutMs: this.config.busyTimeoutMs });
      this.lastIntegrityCheckAt = opened.integrityCheckedAt;
      this.lastSuccessfulIntegrityCheckAt = opened.integrity === 'ok' ? opened.integrityCheckedAt : undefined;
      if (opened.migrationBackup) this.lastBackup = opened.migrationBackup;
      else this.lastBackup ??= await readLatestMemoryBackup(this.config.dbPath) ?? undefined;
      this.components = components;
      this.state = 'healthy';
      this.degradedReason = undefined;
      return components;
    } catch (error) {
      this.lastIntegrityCheckAt = Date.now();
      this.state = 'degraded';
      this.degradedReason = error instanceof Error ? error.message : String(error);
      try { await store.close(); } catch {}
      throw error;
    }
  }
}
