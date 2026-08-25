import type { MemoryAnchor } from './anchors.js';
import type { MemoryRelation, MemoryScope } from './types.js';
import type { MemoryWorkerSqlOperation } from './db-worker.js';
import { MemoryWorkerClient } from './worker-client.js';

export const RELATION_WEIGHTS: Record<MemoryRelation, number> = {
  same_key: 1.00,
  supersedes: 1.00,
  explicit_relation: 1.00,
  same_anchor: 0.95,
  same_artifact: 0.90,
  same_route_or_task: 0.80,
  cooccurs_in_event: 0.60,
  token_overlap: 0.20,
  temporal_neighbor: 0.15,
};

export interface LinkableMemoryRecord {
  memoryId: string;
  canonicalKey: string;
  valueText: string;
  anchors: MemoryAnchor[];
  sourceEventId?: string;
  threadId?: string;
  resourceId?: string;
  createdAt: number;
}

export interface PairRelationOptions {
  tokenOverlapJaccardThreshold: number;
  temporalNeighborWindowMs: number;
  structuredRelations?: MemoryRelation[];
}

export interface ProposedMemoryRelation {
  relation: MemoryRelation;
  weight: number;
}

export interface MemoryLinkerOptions {
  tokenOverlapJaccardThreshold: number;
  temporalNeighborWindowMs: number;
  candidateCap: number;
}

const RELATION_ORDER: MemoryRelation[] = [
  'same_key', 'supersedes', 'explicit_relation', 'same_anchor', 'same_artifact',
  'same_route_or_task', 'cooccurs_in_event', 'token_overlap', 'temporal_neighbor',
];

function tokens(text: string): Set<string> {
  return new Set((text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []));
}

export function jaccardTokenOverlap(left: string, right: string): number {
  const a = tokens(left);
  const b = tokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function sharedAnchor(left: LinkableMemoryRecord, right: LinkableMemoryRecord, types?: Set<string>): boolean {
  const rightValues = new Set(
    right.anchors
      .filter((anchor) => !types || types.has(anchor.type))
      .map((anchor) => `${anchor.type}\0${anchor.value}`),
  );
  return left.anchors.some((anchor) => (!types || types.has(anchor.type)) && rightValues.has(`${anchor.type}\0${anchor.value}`));
}

export function derivePairRelations(
  left: LinkableMemoryRecord,
  right: LinkableMemoryRecord,
  options: PairRelationOptions,
): ProposedMemoryRelation[] {
  const relations = new Map<MemoryRelation, number>();
  for (const relation of options.structuredRelations ?? []) {
    if (relation === 'supersedes' || relation === 'explicit_relation') relations.set(relation, 1);
  }

  if (left.canonicalKey === right.canonicalKey) relations.set('same_key', 1);
  if (sharedAnchor(left, right)) relations.set('same_anchor', 0.95);
  if (sharedAnchor(left, right, new Set(['windows_path', 'unix_path']))) relations.set('same_artifact', 0.90);
  if (sharedAnchor(left, right, new Set(['route_id', 'run_id']))) relations.set('same_route_or_task', 0.80);
  if (left.sourceEventId && left.sourceEventId === right.sourceEventId) relations.set('cooccurs_in_event', 0.60);

  const jaccard = jaccardTokenOverlap(left.valueText, right.valueText);
  if (jaccard >= options.tokenOverlapJaccardThreshold) {
    const span = Math.max(1e-9, 1 - options.tokenOverlapJaccardThreshold);
    const normalized = Math.min(1, Math.max(0, (jaccard - options.tokenOverlapJaccardThreshold) / span));
    relations.set('token_overlap', 0.20 + (0.35 * normalized));
  }

  const sameThread = Boolean(left.threadId && left.threadId === right.threadId);
  const sameResource = Boolean(left.resourceId && left.resourceId === right.resourceId);
  const distance = Math.abs(left.createdAt - right.createdAt);
  if ((sameThread || sameResource) && distance <= options.temporalNeighborWindowMs) {
    const freshness = 1 - Math.min(1, distance / Math.max(1, options.temporalNeighborWindowMs));
    relations.set('temporal_neighbor', 0.15 + (0.15 * freshness));
  }

  return RELATION_ORDER
    .filter((relation) => relations.has(relation))
    .map((relation) => ({ relation, weight: relations.get(relation)! }));
}

type LinkerRow = {
  memory_id: string;
  canonical_key: string;
  value_text: string;
  source_event_id: string | null;
  thread_id: string | null;
  resource_id: string | null;
  event_created_at: number | null;
  item_created_at: number;
};

export class MemoryLinker {
  constructor(
    readonly client: MemoryWorkerClient,
    readonly options: MemoryLinkerOptions,
  ) {
    if (!Number.isInteger(options.candidateCap) || options.candidateCap < 1 || options.candidateCap > 512) {
      throw new Error('candidateCap must be an integer between 1 and 512');
    }
    if (!(options.tokenOverlapJaccardThreshold > 0 && options.tokenOverlapJaccardThreshold < 1)) {
      throw new Error('tokenOverlapJaccardThreshold must be between 0 and 1');
    }
  }

  async linkMemory(scope: Pick<MemoryScope, 'principalId' | 'projectId'>, memoryId: string): Promise<{ createdEdges: number; candidateCount: number }> {
    const project = scope.projectId ?? '';
    const targetRows = await this.client.query<LinkerRow>(
      `SELECT item.id AS memory_id, item.canonical_key, revision.value_text, revision.source_event_id,
              event.thread_id, event.resource_id, event.created_at AS event_created_at, item.created_at AS item_created_at
         FROM memory_items AS item
         JOIN memory_revisions AS revision ON revision.id = item.current_revision_id
         LEFT JOIN memory_events AS event ON event.id = revision.source_event_id
        WHERE item.principal_id = ? AND IFNULL(item.project_id, '') = ? AND item.id = ?
          AND item.state <> 'tombstoned'
        LIMIT 1`,
      [scope.principalId, project, memoryId],
    );
    const targetRow = targetRows[0];
    if (!targetRow) return { createdEdges: 0, candidateCount: 0 };

    const candidateRows = await this.client.query<LinkerRow>(
      `SELECT item.id AS memory_id, item.canonical_key, revision.value_text, revision.source_event_id,
              event.thread_id, event.resource_id, event.created_at AS event_created_at, item.created_at AS item_created_at
         FROM memory_items AS item
         JOIN memory_revisions AS revision ON revision.id = item.current_revision_id
         LEFT JOIN memory_events AS event ON event.id = revision.source_event_id
        WHERE item.principal_id = ? AND IFNULL(item.project_id, '') = ? AND item.id <> ?
          AND item.state <> 'tombstoned'
        ORDER BY item.updated_at DESC, item.id COLLATE BINARY ASC
        LIMIT ?`,
      [scope.principalId, project, memoryId, this.options.candidateCap],
    );

    const ids = [targetRow.memory_id, ...candidateRows.map((row) => row.memory_id)];
    const anchorsByMemory = await this.loadAnchors(ids);
    const target = mapLinkerRow(targetRow, anchorsByMemory.get(targetRow.memory_id) ?? []);
    const operations: MemoryWorkerSqlOperation[] = [];
    const now = Date.now();

    for (const row of candidateRows) {
      const candidate = mapLinkerRow(row, anchorsByMemory.get(row.memory_id) ?? []);
      const relations = derivePairRelations(target, candidate, {
        tokenOverlapJaccardThreshold: this.options.tokenOverlapJaccardThreshold,
        temporalNeighborWindowMs: this.options.temporalNeighborWindowMs,
      });
      const evidenceEventId = target.sourceEventId ?? candidate.sourceEventId ?? null;
      for (const relation of relations) {
        // Associative evidence is traversable in both directions. Structured directed
        // supersession/explicit edges are written by their authoritative caller, not inferred here.
        operations.push(edgeInsert(target.memoryId, candidate.memoryId, relation, evidenceEventId, now));
        operations.push(edgeInsert(candidate.memoryId, target.memoryId, relation, evidenceEventId, now));
      }
    }

    let createdEdges = 0;
    for (let offset = 0; offset < operations.length; offset += 900) {
      const results = await this.client.transaction(operations.slice(offset, offset + 900));
      for (const result of results) {
        if (result && typeof result === 'object' && 'changes' in result) createdEdges += Number((result as { changes: number }).changes);
      }
    }
    return { createdEdges, candidateCount: candidateRows.length };
  }

  private async loadAnchors(memoryIds: string[]): Promise<Map<string, MemoryAnchor[]>> {
    const result = new Map<string, MemoryAnchor[]>();
    if (memoryIds.length === 0) return result;
    const placeholders = memoryIds.map(() => '?').join(',');
    const rows = await this.client.query<{ memory_id: string; anchor: string; anchor_type: string }>(
      `SELECT memory_id, anchor, anchor_type FROM memory_anchors
        WHERE memory_id IN (${placeholders})
        ORDER BY memory_id COLLATE BINARY, anchor_type COLLATE BINARY, anchor COLLATE BINARY`,
      memoryIds,
    );
    for (const row of rows) {
      const list = result.get(row.memory_id) ?? [];
      list.push({ type: row.anchor_type as MemoryAnchor['type'], value: row.anchor });
      result.set(row.memory_id, list);
    }
    return result;
  }
}

function edgeInsert(
  fromMemoryId: string,
  toMemoryId: string,
  relation: ProposedMemoryRelation,
  evidenceEventId: string | null,
  createdAt: number,
): MemoryWorkerSqlOperation {
  return {
    kind: 'run',
    sql: `INSERT OR IGNORE INTO memory_edges(
      from_memory_id, to_memory_id, relation, weight, evidence_event_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    params: [fromMemoryId, toMemoryId, relation.relation, relation.weight, evidenceEventId, createdAt],
  };
}

function mapLinkerRow(row: LinkerRow, anchors: MemoryAnchor[]): LinkableMemoryRecord {
  return {
    memoryId: row.memory_id,
    canonicalKey: row.canonical_key,
    valueText: row.value_text,
    anchors,
    sourceEventId: row.source_event_id ?? undefined,
    threadId: row.thread_id ?? undefined,
    resourceId: row.resource_id ?? undefined,
    createdAt: Number(row.event_created_at ?? row.item_created_at),
  };
}
