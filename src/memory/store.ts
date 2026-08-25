import { createHash, randomUUID } from 'node:crypto';
import { extractMemoryAnchors } from './anchors.js';
import { normalizeCanonicalKey, normalizeMemoryText } from './normalizer.js';
import { redactMemoryText } from './redaction.js';
import {
  INITIAL_MEMORY_MIGRATION,
  MEMORY_FTS_REBUILD_SQL,
  MEMORY_SCHEMA_SQL,
  MEMORY_SCHEMA_VERSION,
} from './schema.js';
import { MUTABLE_MEMORY_KINDS } from './types.js';
import type {
  MemoryCommitRequest,
  MemoryCommitResult,
  MemoryEnforcement,
  MemoryKind,
  MemoryRelation,
  MemoryReviseRequest,
  MemoryReviseResult,
  MemoryScope,
  MemoryState,
} from './types.js';
import { MemoryWorkerClient, type MemoryWorkerClientOptions } from './worker-client.js';
import type { MemoryWorkerSqlOperation, SqlPrimitive } from './db-worker.js';

export class MemoryStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'MemoryStoreError';
    this.code = code;
  }
}

export interface MemoryStoreOpenOptions {
  dbPath: string;
  busyTimeoutMs?: number;
}

export interface RecordMemoryEventRequest {
  scope: MemoryScope;
  eventType: string;
  sourceType: string;
  sourceRef?: string;
  text?: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryEventRecord {
  eventId: string;
  redactedText: string;
  createdAt: number;
}

export interface StoredMemoryRecord {
  memoryId: string;
  revisionId: string;
  revisionNo: number;
  principalId: string;
  projectId?: string;
  canonicalKey: string;
  kind: MemoryKind;
  state: MemoryState;
  importance: number;
  pinned: boolean;
  enforcement: MemoryEnforcement;
  valueText: string;
  valueJson?: string;
  valueHash: string;
  sourceEventId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface StoredMemoryRevision {
  revisionId: string;
  memoryId: string;
  revisionNo: number;
  valueText: string;
  valueJson?: string;
  valueHash: string;
  sourceEventId?: string;
  validFrom: number;
  validTo?: number;
  supersedesRevisionId?: string;
  createdAt: number;
}

type ExistingMemoryRow = {
  id: string;
  canonical_key: string;
  kind: MemoryKind;
  state: MemoryState;
  importance: number;
  pinned: number;
  enforcement: MemoryEnforcement;
  current_revision_id: string;
  created_at: number;
  updated_at: number;
  revision_no: number;
  value_hash: string;
};

const FIXED_RELATION_WEIGHT: Record<MemoryRelation, number> = {
  same_key: 1,
  supersedes: 1,
  explicit_relation: 1,
  same_anchor: 0.95,
  same_artifact: 0.90,
  same_route_or_task: 0.80,
  cooccurs_in_event: 0.60,
  token_overlap: 0.20,
  temporal_neighbor: 0.15,
};

function scopeProject(scope: MemoryScope): string {
  return scope.projectId ?? '';
}

function assertScope(scope: MemoryScope): void {
  if (!scope.principalId?.trim()) throw new MemoryStoreError('MEMORY_SCOPE_REQUIRED', 'principalId is required');
}

function sanitizeStructured(value: unknown, keyName = ''): unknown {
  const secretKey = /^(?:authorization|api[_-]?key|client[_-]?secret|access[_-]?key|password|passwd|pwd|token|refresh[_-]?token|access[_-]?token)$/i;
  if (secretKey.test(keyName)) return '[REDACTED:SECRET]';
  if (typeof value === 'string') return redactMemoryText(value).text;
  if (Array.isArray(value)) return value.map((item) => sanitizeStructured(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sanitizeStructured(item, key)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`;
}

function normalizeValue(value: MemoryCommitRequest['value']): { valueText: string; valueJson?: string; valueHash: string } {
  const sanitized = sanitizeStructured(value);
  let valueText: string;
  let valueJson: string | undefined;

  if (typeof sanitized === 'string') {
    valueText = normalizeMemoryText(sanitized).canonical;
  } else {
    valueJson = stableJson(sanitized);
    valueText = normalizeMemoryText(valueJson).canonical;
  }

  return {
    valueText,
    valueJson,
    valueHash: createHash('sha256').update(valueText, 'utf8').digest('hex'),
  };
}

function metadataJson(metadata: Record<string, unknown> | undefined): string {
  return stableJson(sanitizeStructured(metadata ?? {}));
}

function eventInsertOperation(
  eventId: string,
  request: RecordMemoryEventRequest,
  redactedText: string,
  createdAt: number,
): MemoryWorkerSqlOperation {
  return {
    kind: 'run',
    sql: `INSERT INTO memory_events(
      id, principal_id, project_id, thread_id, resource_id, event_type, source_type, source_ref,
      raw_text, redacted_text, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    params: [
      eventId,
      request.scope.principalId,
      request.scope.projectId ?? null,
      request.scope.threadId ?? null,
      request.scope.resourceId ?? null,
      request.eventType,
      request.sourceType,
      request.sourceRef ? redactMemoryText(request.sourceRef).text : null,
      redactedText,
      metadataJson(request.metadata),
      createdAt,
    ],
  };
}

export class MemoryStore {
  private opened = false;
  private closed = false;

  constructor(readonly client: MemoryWorkerClient = new MemoryWorkerClient()) {}

  static withWorkerOptions(options: MemoryWorkerClientOptions): MemoryStore {
    return new MemoryStore(new MemoryWorkerClient(options));
  }

  async open(options: MemoryStoreOpenOptions): Promise<void> {
    if (this.opened) return;
    if (this.closed) throw new MemoryStoreError('MEMORY_STORE_CLOSED', 'Memory store is closed');
    await this.client.open({ dbPath: options.dbPath, busyTimeoutMs: options.busyTimeoutMs });
    await this.client.exec(MEMORY_SCHEMA_SQL);
    await this.client.transaction([
      {
        kind: 'run',
        sql: 'INSERT OR IGNORE INTO memory_schema_migrations(version, name, applied_at) VALUES (?, ?, ?)',
        params: [MEMORY_SCHEMA_VERSION, INITIAL_MEMORY_MIGRATION, Date.now()],
      },
      { kind: 'exec', sql: `PRAGMA user_version = ${MEMORY_SCHEMA_VERSION}` },
    ]);
    this.opened = true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.client.close();
  }

  async recordEvent(request: RecordMemoryEventRequest): Promise<MemoryEventRecord> {
    this.assertReady();
    assertScope(request.scope);
    if (!request.eventType?.trim() || !request.sourceType?.trim()) {
      throw new MemoryStoreError('MEMORY_EVENT_INVALID', 'eventType and sourceType are required');
    }
    const eventId = randomUUID();
    const createdAt = Date.now();
    const redactedText = normalizeMemoryText(redactMemoryText(request.text ?? '').text).canonical;
    await this.client.transaction([eventInsertOperation(eventId, request, redactedText, createdAt)]);
    return { eventId, redactedText, createdAt };
  }

  async commitMemory(request: MemoryCommitRequest): Promise<MemoryCommitResult> {
    this.assertReady();
    assertScope(request.scope);
    const canonicalKey = normalizeCanonicalKey(request.canonicalKey ?? '');
    if (!canonicalKey) throw new MemoryStoreError('MEMORY_CANONICAL_KEY_REQUIRED', 'canonicalKey is required');
    const importance = request.importance ?? 0.5;
    if (!Number.isFinite(importance) || importance < 0 || importance > 1) {
      throw new MemoryStoreError('MEMORY_IMPORTANCE_INVALID', 'importance must be between 0 and 1');
    }

    const normalized = normalizeValue(request.value);
    const existing = await this.findByCanonicalKey(request.scope, canonicalKey);
    if (existing && existing.kind !== request.kind) {
      throw new MemoryStoreError('MEMORY_KIND_MISMATCH', 'canonicalKey already exists with a different memory kind');
    }
    if (existing && existing.value_hash !== normalized.valueHash && request.revisionAuthority !== 'structured_state') {
      throw new MemoryStoreError(
        'MEMORY_REVISION_REQUIRED',
        'Changing an existing canonical memory requires memory_revise or structured revision authority',
      );
    }

    return this.writeRevision({
      request,
      canonicalKey,
      normalized,
      existing,
      eventType: existing && existing.value_hash !== normalized.valueHash ? 'memory.revised' : 'memory.committed',
    });
  }

  async reviseMemory(request: MemoryReviseRequest): Promise<MemoryReviseResult> {
    this.assertReady();
    assertScope(request.scope);
    const current = await this.findById(request.scope, request.memoryId);
    if (!current) throw new MemoryStoreError('MEMORY_NOT_FOUND', 'Memory not found in authenticated scope');
    if (!MUTABLE_MEMORY_KINDS.includes(current.kind as (typeof MUTABLE_MEMORY_KINDS)[number])) {
      throw new MemoryStoreError('MEMORY_KIND_IMMUTABLE', `Memory kind "${current.kind}" cannot be revised in place`);
    }
    const normalized = normalizeValue(request.value);
    const result = await this.writeRevision({
      request: {
        scope: request.scope,
        canonicalKey: current.canonical_key,
        kind: current.kind,
        value: request.value,
        importance: current.importance,
        pinned: current.pinned === 1,
        enforcement: current.enforcement,
        sourceType: request.sourceType,
        sourceRef: request.sourceRef,
        metadata: request.metadata,
      },
      canonicalKey: current.canonical_key,
      normalized,
      existing: current,
      eventType: 'memory.revised',
    });
    return {
      ...result,
      supersededRevisionId: result.revisionId === current.current_revision_id ? undefined : current.current_revision_id,
    };
  }

  async getMemory(scope: MemoryScope, memoryId: string): Promise<StoredMemoryRecord | null> {
    this.assertReady();
    assertScope(scope);
    const rows = await this.client.query<Record<string, unknown>>(
      `SELECT
        item.id AS memory_id, item.principal_id, item.project_id, item.canonical_key, item.kind, item.state,
        item.importance, item.pinned, item.enforcement, item.created_at, item.updated_at,
        revision.id AS revision_id, revision.revision_no, revision.value_text, revision.value_json,
        revision.value_hash, revision.source_event_id
       FROM memory_items AS item
       JOIN memory_revisions AS revision ON revision.id = item.current_revision_id
       WHERE item.principal_id = ? AND IFNULL(item.project_id, '') = ? AND item.id = ?
       LIMIT 1`,
      [scope.principalId, scopeProject(scope), memoryId],
    );
    const row = rows[0];
    return row ? mapStoredMemory(row) : null;
  }

  async listRevisions(scope: MemoryScope, memoryId: string): Promise<StoredMemoryRevision[]> {
    this.assertReady();
    assertScope(scope);
    const rows = await this.client.query<Record<string, unknown>>(
      `SELECT revision.id AS revision_id, revision.memory_id, revision.revision_no, revision.value_text,
              revision.value_json, revision.value_hash, revision.source_event_id, revision.valid_from,
              revision.valid_to, revision.supersedes_revision_id, revision.created_at
         FROM memory_revisions AS revision
         JOIN memory_items AS item ON item.id = revision.memory_id
        WHERE item.principal_id = ? AND IFNULL(item.project_id, '') = ? AND item.id = ?
        ORDER BY revision.revision_no ASC`,
      [scope.principalId, scopeProject(scope), memoryId],
    );
    return rows.map(mapRevision);
  }

  async tombstoneMemory(scope: MemoryScope, memoryId: string, reason: string): Promise<void> {
    this.assertReady();
    assertScope(scope);
    const current = await this.findById(scope, memoryId);
    if (!current) throw new MemoryStoreError('MEMORY_NOT_FOUND', 'Memory not found in authenticated scope');
    const eventId = randomUUID();
    const now = Date.now();
    const eventRequest: RecordMemoryEventRequest = {
      scope,
      eventType: 'memory.tombstoned',
      sourceType: 'memory_forget',
      sourceRef: memoryId,
      text: reason,
      metadata: { memoryId },
    };
    const redacted = normalizeMemoryText(redactMemoryText(reason).text).canonical;
    await this.client.transaction([
      eventInsertOperation(eventId, eventRequest, redacted, now),
      {
        kind: 'run',
        sql: `UPDATE memory_items SET state = 'tombstoned', updated_at = ?
              WHERE id = ? AND principal_id = ? AND IFNULL(project_id, '') = ?`,
        params: [now, memoryId, scope.principalId, scopeProject(scope)],
      },
      { kind: 'exec', sql: MEMORY_FTS_REBUILD_SQL },
    ]);
  }

  private async writeRevision(input: {
    request: MemoryCommitRequest;
    canonicalKey: string;
    normalized: { valueText: string; valueJson?: string; valueHash: string };
    existing: ExistingMemoryRow | null;
    eventType: string;
  }): Promise<MemoryCommitResult> {
    const { request, canonicalKey, normalized, existing } = input;
    const now = Date.now();
    const eventId = randomUUID();
    const memoryId = existing?.id ?? randomUUID();
    const eventRequest: RecordMemoryEventRequest = {
      scope: request.scope,
      eventType: input.eventType,
      sourceType: request.sourceType ?? 'primary_ai',
      sourceRef: request.sourceRef,
      text: normalized.valueText,
      metadata: {
        ...(request.metadata ?? {}),
        canonicalKey,
        kind: request.kind,
        memoryId,
      },
    };

    if (existing?.value_hash === normalized.valueHash) {
      await this.client.transaction([
        eventInsertOperation(eventId, eventRequest, normalized.valueText, now),
        {
          kind: 'run',
          sql: 'UPDATE memory_items SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ? AND principal_id = ?',
          params: [now, memoryId, request.scope.principalId],
        },
      ]);
      return {
        memoryId,
        revisionId: existing.current_revision_id,
        eventId,
        revisionNo: existing.revision_no,
        deduplicated: true,
        state: existing.state,
      };
    }

    const revisionId = randomUUID();
    const revisionNo = (existing?.revision_no ?? 0) + 1;
    const operations: MemoryWorkerSqlOperation[] = [eventInsertOperation(eventId, eventRequest, normalized.valueText, now)];

    if (!existing) {
      operations.push({
        kind: 'run',
        sql: `INSERT INTO memory_items(
          id, principal_id, project_id, canonical_key, kind, state, importance, pinned, enforcement,
          current_revision_id, created_at, updated_at, last_accessed_at, access_count
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL, ?, ?, ?, 0)`,
        params: [
          memoryId,
          request.scope.principalId,
          request.scope.projectId ?? null,
          canonicalKey,
          request.kind,
          request.importance ?? 0.5,
          request.pinned ? 1 : 0,
          request.enforcement ?? 'none',
          now,
          now,
          now,
        ],
      });
    } else {
      operations.push({
        kind: 'run',
        sql: 'UPDATE memory_revisions SET valid_to = ? WHERE id = ? AND valid_to IS NULL',
        params: [now, existing.current_revision_id],
      });
    }

    operations.push({
      kind: 'run',
      sql: `INSERT INTO memory_revisions(
        id, memory_id, revision_no, value_text, value_json, value_hash, source_event_id,
        valid_from, valid_to, supersedes_revision_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      params: [
        revisionId,
        memoryId,
        revisionNo,
        normalized.valueText,
        normalized.valueJson ?? null,
        normalized.valueHash,
        eventId,
        now,
        existing?.current_revision_id ?? null,
        now,
      ],
    });
    operations.push({
      kind: 'run',
      sql: `UPDATE memory_items
               SET current_revision_id = ?, state = 'active', importance = ?, pinned = ?, enforcement = ?,
                   updated_at = ?, last_accessed_at = ?
             WHERE id = ? AND principal_id = ?`,
      params: [
        revisionId,
        request.importance ?? existing?.importance ?? 0.5,
        request.pinned === undefined ? (existing?.pinned ?? 0) : (request.pinned ? 1 : 0),
        request.enforcement ?? existing?.enforcement ?? 'none',
        now,
        now,
        memoryId,
        request.scope.principalId,
      ],
    });
    operations.push({ kind: 'run', sql: 'DELETE FROM memory_anchors WHERE memory_id = ?', params: [memoryId] });

    const anchors = extractMemoryAnchors(`${canonicalKey} ${normalized.valueText}`).slice(0, 128);
    operations.push({
      kind: 'run',
      sql: 'INSERT OR IGNORE INTO memory_anchors(memory_id, anchor, anchor_type, created_at) VALUES (?, ?, ?, ?)',
      params: [memoryId, canonicalKey, 'canonical_key', now],
    });
    for (const anchor of anchors) {
      operations.push({
        kind: 'run',
        sql: 'INSERT OR IGNORE INTO memory_anchors(memory_id, anchor, anchor_type, created_at) VALUES (?, ?, ?, ?)',
        params: [memoryId, anchor.value, anchor.type, now],
      });
    }

    for (const relation of request.explicitRelations ?? []) {
      const weight = relation.weight ?? FIXED_RELATION_WEIGHT[relation.relation];
      if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
        throw new MemoryStoreError('MEMORY_RELATION_WEIGHT_INVALID', 'explicit relation weight must be between 0 and 1');
      }
      operations.push({
        kind: 'run',
        sql: `INSERT OR IGNORE INTO memory_edges(
          from_memory_id, to_memory_id, relation, weight, evidence_event_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        params: [memoryId, relation.targetMemoryId, relation.relation, weight, eventId, now],
      });
    }

    operations.push({ kind: 'exec', sql: MEMORY_FTS_REBUILD_SQL });
    await this.client.transaction(operations);

    return {
      memoryId,
      revisionId,
      eventId,
      revisionNo,
      deduplicated: false,
      state: 'active',
    };
  }

  private async findByCanonicalKey(scope: MemoryScope, canonicalKey: string): Promise<ExistingMemoryRow | null> {
    const rows = await this.client.query<ExistingMemoryRow>(
      `SELECT item.id, item.canonical_key, item.kind, item.state, item.importance, item.pinned,
              item.enforcement, item.current_revision_id, item.created_at, item.updated_at,
              revision.revision_no, revision.value_hash
         FROM memory_items AS item
         JOIN memory_revisions AS revision ON revision.id = item.current_revision_id
        WHERE item.principal_id = ? AND IFNULL(item.project_id, '') = ? AND item.canonical_key = ?
        LIMIT 1`,
      [scope.principalId, scopeProject(scope), canonicalKey],
    );
    return rows[0] ?? null;
  }

  private async findById(scope: MemoryScope, memoryId: string): Promise<ExistingMemoryRow | null> {
    const rows = await this.client.query<ExistingMemoryRow>(
      `SELECT item.id, item.canonical_key, item.kind, item.state, item.importance, item.pinned,
              item.enforcement, item.current_revision_id, item.created_at, item.updated_at,
              revision.revision_no, revision.value_hash
         FROM memory_items AS item
         JOIN memory_revisions AS revision ON revision.id = item.current_revision_id
        WHERE item.principal_id = ? AND IFNULL(item.project_id, '') = ? AND item.id = ?
        LIMIT 1`,
      [scope.principalId, scopeProject(scope), memoryId],
    );
    return rows[0] ?? null;
  }

  private assertReady(): void {
    if (!this.opened || this.closed) throw new MemoryStoreError('MEMORY_STORE_NOT_OPEN', 'Memory store is not open');
  }
}

function mapStoredMemory(row: Record<string, unknown>): StoredMemoryRecord {
  return {
    memoryId: String(row.memory_id),
    revisionId: String(row.revision_id),
    revisionNo: Number(row.revision_no),
    principalId: String(row.principal_id),
    projectId: row.project_id == null ? undefined : String(row.project_id),
    canonicalKey: String(row.canonical_key),
    kind: String(row.kind) as MemoryKind,
    state: String(row.state) as MemoryState,
    importance: Number(row.importance),
    pinned: Number(row.pinned) === 1,
    enforcement: String(row.enforcement) as MemoryEnforcement,
    valueText: String(row.value_text),
    valueJson: row.value_json == null ? undefined : String(row.value_json),
    valueHash: String(row.value_hash),
    sourceEventId: row.source_event_id == null ? undefined : String(row.source_event_id),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapRevision(row: Record<string, unknown>): StoredMemoryRevision {
  return {
    revisionId: String(row.revision_id),
    memoryId: String(row.memory_id),
    revisionNo: Number(row.revision_no),
    valueText: String(row.value_text),
    valueJson: row.value_json == null ? undefined : String(row.value_json),
    valueHash: String(row.value_hash),
    sourceEventId: row.source_event_id == null ? undefined : String(row.source_event_id),
    validFrom: Number(row.valid_from),
    validTo: row.valid_to == null ? undefined : Number(row.valid_to),
    supersedesRevisionId: row.supersedes_revision_id == null ? undefined : String(row.supersedes_revision_id),
    createdAt: Number(row.created_at),
  };
}
