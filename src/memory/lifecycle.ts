import { randomUUID } from 'node:crypto';
import type { MemoryConfig } from '../config.js';
import type { MemoryWorkerSqlOperation } from './db-worker.js';
import { MEMORY_FTS_REBUILD_SQL } from './schema.js';
import type { MemoryScope } from './types.js';
import { MemoryWorkerClient } from './worker-client.js';

export interface MemoryConflictRecord {
  conflictId: string;
  leftMemoryId: string;
  rightMemoryId: string;
  conflictType: string;
  status: 'open' | 'resolved';
  evidence: Record<string, unknown>;
  createdAt: number;
  resolvedAt?: number;
}

export interface MemoryCompactionResult {
  archivedMemoryIds: string[];
  cleanedEdges: number;
  integrity: string;
}

type ScopeItemRow = {
  id: string;
};

type ConflictRow = {
  id: string;
  left_memory_id: string;
  right_memory_id: string;
  conflict_type: string;
  status: string;
  evidence_json: string;
  created_at: number;
  resolved_at: number | null;
};

function scopeProject(scope: MemoryScope): string {
  return scope.projectId ?? '';
}

function assertScope(scope: MemoryScope): void {
  if (!scope.principalId?.trim()) throw new Error('Memory lifecycle scope requires principalId');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`;
}

function parseEvidence(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export class MemoryLifecycle {
  constructor(
    readonly client: MemoryWorkerClient,
    readonly config: MemoryConfig,
  ) {}

  async openConflict(
    scope: MemoryScope,
    leftMemoryId: string,
    rightMemoryId: string,
    conflictType: string,
    evidence: Record<string, unknown>,
  ): Promise<MemoryConflictRecord> {
    assertScope(scope);
    if (!leftMemoryId || !rightMemoryId || leftMemoryId === rightMemoryId) {
      throw new Error('Conflict requires two distinct memory IDs in the same scope');
    }
    if (!conflictType.trim()) throw new Error('Conflict type is required');

    const placeholders = '?, ?';
    const rows = await this.client.query<ScopeItemRow>(
      `SELECT id
         FROM memory_items
        WHERE principal_id = ? AND IFNULL(project_id, '') = ?
          AND state <> 'tombstoned'
          AND id IN (${placeholders})
        ORDER BY id COLLATE BINARY`,
      [scope.principalId, scopeProject(scope), leftMemoryId, rightMemoryId],
    );
    if (rows.length !== 2) throw new Error('Conflict memories must both exist inside the authenticated scope');

    const conflictId = randomUUID();
    const createdAt = Date.now();
    const evidenceJson = stableJson(evidence);
    await this.client.transaction([
      {
        kind: 'run',
        sql: `INSERT INTO memory_conflicts(
          id, left_memory_id, right_memory_id, conflict_type, status, evidence_json, created_at, resolved_at
        ) VALUES (?, ?, ?, ?, 'open', ?, ?, NULL)`,
        params: [conflictId, leftMemoryId, rightMemoryId, conflictType, evidenceJson, createdAt],
      },
      {
        kind: 'run',
        sql: `UPDATE memory_items
                 SET state = 'conflicted', updated_at = ?
               WHERE principal_id = ? AND IFNULL(project_id, '') = ? AND id IN (?, ?)`,
        params: [createdAt, scope.principalId, scopeProject(scope), leftMemoryId, rightMemoryId],
      },
      { kind: 'exec', sql: MEMORY_FTS_REBUILD_SQL },
    ]);

    return {
      conflictId,
      leftMemoryId,
      rightMemoryId,
      conflictType,
      status: 'open',
      evidence,
      createdAt,
    };
  }

  async listOpenConflicts(scope: MemoryScope): Promise<MemoryConflictRecord[]> {
    assertScope(scope);
    const rows = await this.client.query<ConflictRow>(
      `SELECT conflict.id, conflict.left_memory_id, conflict.right_memory_id, conflict.conflict_type,
              conflict.status, conflict.evidence_json, conflict.created_at, conflict.resolved_at
         FROM memory_conflicts AS conflict
         JOIN memory_items AS left_item ON left_item.id = conflict.left_memory_id
         JOIN memory_items AS right_item ON right_item.id = conflict.right_memory_id
        WHERE conflict.status = 'open'
          AND left_item.principal_id = ? AND IFNULL(left_item.project_id, '') = ?
          AND right_item.principal_id = ? AND IFNULL(right_item.project_id, '') = ?
        ORDER BY conflict.created_at ASC, conflict.id COLLATE BINARY`,
      [scope.principalId, scopeProject(scope), scope.principalId, scopeProject(scope)],
    );
    return rows.map((row) => ({
      conflictId: row.id,
      leftMemoryId: row.left_memory_id,
      rightMemoryId: row.right_memory_id,
      conflictType: row.conflict_type,
      status: row.status === 'resolved' ? 'resolved' : 'open',
      evidence: parseEvidence(row.evidence_json),
      createdAt: Number(row.created_at),
      resolvedAt: row.resolved_at == null ? undefined : Number(row.resolved_at),
    }));
  }

  async compact(scope: MemoryScope, now = Date.now()): Promise<MemoryCompactionResult> {
    assertScope(scope);
    if (!Number.isFinite(now)) throw new Error('Compaction time must be finite');
    const cutoff = now - this.config.archiveObservationAfterMs;
    const candidates = await this.client.query<ScopeItemRow>(
      `SELECT id
         FROM memory_items
        WHERE principal_id = ? AND IFNULL(project_id, '') = ?
          AND kind = 'observation' AND state = 'active'
          AND pinned = 0 AND importance <= 0.5 AND access_count = 0
          AND updated_at <= ?
        ORDER BY id COLLATE BINARY`,
      [scope.principalId, scopeProject(scope), cutoff],
    );
    const archivedMemoryIds = candidates.map((row) => row.id);
    const operations: MemoryWorkerSqlOperation[] = archivedMemoryIds.map((memoryId) => ({
      kind: 'run' as const,
      sql: `UPDATE memory_items
               SET state = 'archived', updated_at = ?
             WHERE id = ? AND principal_id = ? AND IFNULL(project_id, '') = ?
               AND kind = 'observation' AND state = 'active' AND pinned = 0`,
      params: [now, memoryId, scope.principalId, scopeProject(scope)],
    }));
    operations.push({
      kind: 'run',
      sql: `DELETE FROM memory_edges
             WHERE from_memory_id IN (
               SELECT id FROM memory_items
                WHERE principal_id = ? AND IFNULL(project_id, '') = ? AND state IN ('archived', 'tombstoned')
             )
                OR to_memory_id IN (
               SELECT id FROM memory_items
                WHERE principal_id = ? AND IFNULL(project_id, '') = ? AND state IN ('archived', 'tombstoned')
             )`,
      params: [scope.principalId, scopeProject(scope), scope.principalId, scopeProject(scope)],
    });
    operations.push({ kind: 'exec', sql: MEMORY_FTS_REBUILD_SQL, params: [] });

    const results = await this.client.transaction(operations);
    const edgeDeleteIndex = archivedMemoryIds.length;
    const edgeDelete = results[edgeDeleteIndex];
    const cleanedEdges = edgeDelete && typeof edgeDelete === 'object' && 'changes' in edgeDelete
      ? Number((edgeDelete as { changes: number }).changes)
      : 0;
    const integrity = await this.client.integrity();
    return {
      archivedMemoryIds,
      cleanedEdges,
      integrity: integrity.result,
    };
  }
}
