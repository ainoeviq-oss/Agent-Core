import { createHash } from 'node:crypto';
import type { MemoryConfig } from '../config.js';
import { extractMemoryAnchors } from './anchors.js';
import { normalizeCanonicalKey, normalizeMemoryText } from './normalizer.js';
import { runPersonalizedPageRank, type PageRankEdge } from './ppr.js';
import { redactMemoryText } from './redaction.js';
import {
  combineMemoryScore,
  memoryImportanceScore,
  memoryStateScore,
  type MemoryScoreComponents,
} from './scoring.js';
import type {
  MemoryEnforcement,
  MemoryKind,
  MemoryScope,
  MemorySearchHit,
  MemorySearchRequest,
  MemorySearchResult,
  MemoryState,
} from './types.js';
import { MemoryWorkerClient } from './worker-client.js';

interface SeedEvidence {
  exact: number;
  lexical: number;
  bm25?: number;
}

type CandidateRow = {
  memory_id: string;
  revision_id: string;
  revision_no: number;
  canonical_key: string;
  kind: MemoryKind;
  state: MemoryState;
  enforcement: MemoryEnforcement;
  importance: number;
  pinned: number;
  value_text: string;
  source_event_id: string | null;
  created_at: number;
  updated_at: number;
  last_accessed_at: number;
  access_count: number;
}

type EdgeRow = {
  from_memory_id: string;
  to_memory_id: string;
  relation: string;
  weight: number;
}

function scopeProject(scope: MemoryScope): string {
  return scope.projectId ?? '';
}

function statePredicate(includeHistory: boolean): string {
  return includeHistory
    ? "item.state <> 'tombstoned'"
    : "item.state NOT IN ('tombstoned', 'superseded')";
}

function lexicalTerms(text: string): string[] {
  return [...new Set(text.match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])]
    .sort((left, right) => left.localeCompare(right));
}

function ftsMatchQuery(terms: readonly string[]): string {
  return terms
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(' OR ');
}

function stableSnapshotHash(query: string, hits: readonly MemorySearchHit[], graphTruncated: boolean): string {
  const payload = JSON.stringify({
    query,
    graphTruncated,
    hits: hits.map((hit) => ({
      memoryId: hit.memoryId,
      revisionId: hit.revisionId,
      revisionNo: hit.revisionNo,
      state: hit.state,
      finalScore: Number(hit.whyMatched.finalScore.toFixed(12)),
      matchedAnchors: hit.whyMatched.matchedAnchors,
      lexicalTerms: hit.whyMatched.lexicalTerms ?? [],
      graphPath: hit.whyMatched.graphPath ?? [],
    })),
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

function compareHardFirst(left: MemorySearchHit, right: MemorySearchHit): number {
  const leftHard = left.kind === 'guardrail' && left.state === 'active' && left.enforcement === 'hard';
  const rightHard = right.kind === 'guardrail' && right.state === 'active' && right.enforcement === 'hard';
  if (leftHard !== rightHard) return leftHard ? -1 : 1;
  const scoreDelta = right.whyMatched.finalScore - left.whyMatched.finalScore;
  if (scoreDelta !== 0) return scoreDelta;
  return left.memoryId.localeCompare(right.memoryId);
}

export class MemoryRetriever {
  constructor(
    readonly client: MemoryWorkerClient,
    readonly config: MemoryConfig,
  ) {}

  async search(request: MemorySearchRequest): Promise<MemorySearchResult> {
    if (!request.scope.principalId?.trim()) throw new Error('principalId is required');
    const safeQuery = normalizeMemoryText(redactMemoryText(request.query ?? '').text).canonical;
    if (!safeQuery) {
      return {
        query: '',
        hits: [],
        graphTruncated: false,
        snapshotHash: stableSnapshotHash('', [], false),
      };
    }

    const terms = lexicalTerms(normalizeMemoryText(safeQuery).search);
    const anchors = extractMemoryAnchors(safeQuery);
    const anchorValues = [...new Set(anchors.map((anchor) => anchor.value))]
      .sort((left, right) => left.localeCompare(right));
    const canonicalQuery = normalizeCanonicalKey(safeQuery);
    const seeds = new Map<string, SeedEvidence>();

    await this.collectExactSeeds(request, canonicalQuery, anchorValues, seeds);
    await this.collectLexicalSeeds(request, terms, seeds);

    const orderedSeeds = [...seeds.entries()]
      .sort(([leftId, left], [rightId, right]) => {
        const leftStrength = Math.max(left.exact, left.lexical);
        const rightStrength = Math.max(right.exact, right.lexical);
        return rightStrength - leftStrength || leftId.localeCompare(rightId);
      })
      .slice(0, this.config.seedCap);
    const boundedSeeds = new Map(orderedSeeds);

    if (boundedSeeds.size === 0) {
      return {
        query: safeQuery,
        hits: [],
        graphTruncated: false,
        snapshotHash: stableSnapshotHash(safeQuery, [], false),
      };
    }

    const graph = await this.expandGraph(request, [...boundedSeeds.keys()]);
    const rows = await this.loadCandidateRows(request, [...graph.nodeIds]);
    const rowById = new Map(rows.map((row) => [row.memory_id, row]));
    const validNodeIds = [...graph.nodeIds].filter((id) => rowById.has(id)).sort((a, b) => a.localeCompare(b));
    const validNodeSet = new Set(validNodeIds);
    const validEdges = graph.edges.filter((edge) => validNodeSet.has(edge.from) && validNodeSet.has(edge.to));

    const personalization = new Map<string, number>();
    for (const id of validNodeIds) {
      const seed = boundedSeeds.get(id);
      if (seed) personalization.set(id, Math.max(seed.exact, seed.lexical, 1e-9));
    }
    const ppr = runPersonalizedPageRank({
      nodes: validNodeIds,
      edges: validEdges,
      personalization,
      damping: this.config.pprDamping,
      epsilon: this.config.pprEpsilon,
      maxIterations: this.config.pprMaxIterations,
      maxNodes: this.config.graphNodeCap,
      maxEdges: this.config.graphEdgeCap,
    });
    const pprById = new Map(ppr.ranking.map((row) => [row.memoryId, row.score]));
    const maxPpr = Math.max(0, ...ppr.ranking.map((row) => row.score));

    const anchorsByMemory = await this.loadAnchors(validNodeIds);
    const recencyById = this.computeRecencyAccess(rows);
    const hits = rows.map((row): MemorySearchHit => {
      const seed = boundedSeeds.get(row.memory_id) ?? { exact: 0, lexical: 0 };
      const candidateAnchors = anchorsByMemory.get(row.memory_id) ?? [];
      const matchedAnchors = candidateAnchors
        .filter((anchor) => anchorValues.includes(anchor))
        .sort((a, b) => a.localeCompare(b));
      if (row.canonical_key === canonicalQuery && canonicalQuery && !matchedAnchors.includes(canonicalQuery)) {
        matchedAnchors.unshift(canonicalQuery);
      }
      const candidateTerms = new Set(lexicalTerms(normalizeMemoryText(`${row.canonical_key} ${row.value_text}`).search));
      const matchedTerms = terms.filter((term) => candidateTerms.has(term));
      const components: MemoryScoreComponents = {
        lexical: seed.lexical,
        exact: seed.exact,
        graph: maxPpr > 0 ? (pprById.get(row.memory_id) ?? 0) / maxPpr : 0,
        state: memoryStateScore(row.kind, row.state, row.enforcement),
        importance: memoryImportanceScore(row.importance, row.pinned === 1),
        recency: recencyById.get(row.memory_id) ?? 0,
      };
      const finalScore = combineMemoryScore(components, this.config.scoreWeights);
      return {
        memoryId: row.memory_id,
        revisionId: row.revision_id,
        revisionNo: Number(row.revision_no),
        canonicalKey: row.canonical_key,
        kind: row.kind,
        state: row.state,
        enforcement: row.enforcement,
        importance: Number(row.importance),
        pinned: Number(row.pinned) === 1,
        valueText: row.value_text,
        sourceEventId: row.source_event_id ?? undefined,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        whyMatched: {
          ...components,
          finalScore,
          lexicalTerms: matchedTerms,
          matchedAnchors,
          graphPath: graph.paths.get(row.memory_id),
        },
      };
    }).sort(compareHardFirst);

    const limit = Math.max(1, Math.min(request.limit ?? this.config.recallItemBudget, this.config.recallItemBudget));
    const characterBudget = Math.max(1, Math.min(
      request.characterBudget ?? this.config.recallCharacterBudget,
      this.config.recallCharacterBudget,
    ));
    const packed: MemorySearchHit[] = [];
    let characters = 0;
    for (const hit of hits) {
      if (packed.length >= limit) break;
      const hard = hit.kind === 'guardrail' && hit.state === 'active' && hit.enforcement === 'hard';
      if (!hard && characters + hit.valueText.length > characterBudget) continue;
      packed.push(hit);
      characters += hit.valueText.length;
    }

    const graphTruncated = graph.truncated || ppr.graphTruncated;
    return {
      query: safeQuery,
      hits: packed,
      graphTruncated,
      snapshotHash: stableSnapshotHash(safeQuery, packed, graphTruncated),
    };
  }

  private async collectExactSeeds(
    request: MemorySearchRequest,
    canonicalQuery: string,
    anchorValues: string[],
    seeds: Map<string, SeedEvidence>,
  ): Promise<void> {
    const params: Array<string | number | null> = [request.scope.principalId, scopeProject(request.scope), canonicalQuery];
    let anchorClause = '';
    if (anchorValues.length > 0) {
      anchorClause = ` OR anchor.anchor IN (${anchorValues.map(() => '?').join(',')})`;
      params.push(...anchorValues);
    }
    const rows = await this.client.query<{ memory_id: string }>(
      `SELECT DISTINCT item.id AS memory_id
         FROM memory_items AS item
         LEFT JOIN memory_anchors AS anchor ON anchor.memory_id = item.id
        WHERE item.principal_id = ? AND IFNULL(item.project_id, '') = ?
          AND ${statePredicate(Boolean(request.includeHistory))}
          AND (item.canonical_key = ?${anchorClause})
        ORDER BY item.id COLLATE BINARY
        LIMIT ?`,
      [...params, this.config.seedCap],
    );
    for (const row of rows) {
      const current = seeds.get(row.memory_id) ?? { exact: 0, lexical: 0 };
      current.exact = 1;
      seeds.set(row.memory_id, current);
    }
  }

  private async collectLexicalSeeds(
    request: MemorySearchRequest,
    terms: string[],
    seeds: Map<string, SeedEvidence>,
  ): Promise<void> {
    if (terms.length === 0) return;
    const rows = await this.client.query<{ memory_id: string; score: number }>(
      `SELECT memory_id, bm25(memory_fts) AS score
         FROM memory_fts
        WHERE memory_fts MATCH ? AND principal_id = ? AND project_id = ?
          AND ${request.includeHistory ? "state <> 'tombstoned'" : "state NOT IN ('tombstoned', 'superseded')"}
        ORDER BY score ASC, memory_id COLLATE BINARY ASC
        LIMIT ?`,
      [ftsMatchQuery(terms), request.scope.principalId, scopeProject(request.scope), this.config.seedCap],
    );
    const count = rows.length;
    rows.forEach((row, index) => {
      const current = seeds.get(row.memory_id) ?? { exact: 0, lexical: 0 };
      current.lexical = Math.max(current.lexical, count === 0 ? 0 : 1 - (index / Math.max(1, count)));
      current.bm25 = Number(row.score);
      seeds.set(row.memory_id, current);
    });
  }

  private async expandGraph(
    request: MemorySearchRequest,
    seedIds: string[],
  ): Promise<{ nodeIds: Set<string>; edges: PageRankEdge[]; paths: Map<string, string[]>; truncated: boolean }> {
    const nodeIds = new Set(seedIds.slice(0, this.config.graphNodeCap));
    const paths = new Map<string, string[]>([...nodeIds].map((id) => [id, [id]]));
    const edgeMap = new Map<string, PageRankEdge>();
    let frontier = [...nodeIds].sort((a, b) => a.localeCompare(b));
    let truncated = seedIds.length > this.config.graphNodeCap;

    for (let hop = 0; hop < this.config.graphMaxHops && frontier.length > 0; hop += 1) {
      const nextFrontier: string[] = [];
      for (let offset = 0; offset < frontier.length; offset += 200) {
        const chunk = frontier.slice(offset, offset + 200);
        const placeholders = chunk.map(() => '?').join(',');
        const rows = await this.client.query<EdgeRow>(
          `SELECT edge.from_memory_id, edge.to_memory_id, edge.relation, edge.weight
             FROM memory_edges AS edge
             JOIN memory_items AS source ON source.id = edge.from_memory_id
             JOIN memory_items AS target ON target.id = edge.to_memory_id
            WHERE source.principal_id = ? AND IFNULL(source.project_id, '') = ?
              AND target.principal_id = ? AND IFNULL(target.project_id, '') = ?
              AND ${statePredicate(Boolean(request.includeHistory)).replaceAll('item.', 'source.')}
              AND ${statePredicate(Boolean(request.includeHistory)).replaceAll('item.', 'target.')}
              AND (edge.from_memory_id IN (${placeholders}) OR edge.to_memory_id IN (${placeholders}))
            ORDER BY edge.weight DESC, edge.from_memory_id COLLATE BINARY, edge.to_memory_id COLLATE BINARY, edge.relation COLLATE BINARY`,
          [
            request.scope.principalId,
            scopeProject(request.scope),
            request.scope.principalId,
            scopeProject(request.scope),
            ...chunk,
            ...chunk,
          ],
        );
        for (const row of rows) {
          const edgeKey = `${row.from_memory_id}\0${row.to_memory_id}\0${row.relation}`;
          if (!edgeMap.has(edgeKey)) {
            if (edgeMap.size >= this.config.graphEdgeCap) {
              truncated = true;
              continue;
            }
            edgeMap.set(edgeKey, { from: row.from_memory_id, to: row.to_memory_id, weight: Number(row.weight) });
          }
          const endpoints: Array<[string, string]> = [
            [row.from_memory_id, row.to_memory_id],
            [row.to_memory_id, row.from_memory_id],
          ];
          for (const [known, discovered] of endpoints) {
            if (!nodeIds.has(known) || nodeIds.has(discovered)) continue;
            if (nodeIds.size >= this.config.graphNodeCap) {
              truncated = true;
              continue;
            }
            nodeIds.add(discovered);
            nextFrontier.push(discovered);
            const parentPath = paths.get(known) ?? [known];
            paths.set(discovered, [...parentPath, discovered]);
          }
        }
      }
      frontier = [...new Set(nextFrontier)].sort((a, b) => a.localeCompare(b));
    }

    const seedSet = new Set(seedIds);
    const orderedEdges = [...edgeMap.values()].sort(
      (left, right) => right.weight - left.weight || left.from.localeCompare(right.from) || left.to.localeCompare(right.to),
    );
    for (const edge of orderedEdges) {
      if (!seedSet.has(edge.from) || !seedSet.has(edge.to) || edge.from === edge.to) continue;
      if ((paths.get(edge.to)?.length ?? 0) <= 1) paths.set(edge.to, [edge.from, edge.to]);
    }

    return { nodeIds, edges: [...edgeMap.values()], paths, truncated };
  }

  private async loadCandidateRows(request: MemorySearchRequest, memoryIds: string[]): Promise<CandidateRow[]> {
    const rows: CandidateRow[] = [];
    for (let offset = 0; offset < memoryIds.length; offset += 400) {
      const chunk = memoryIds.slice(offset, offset + 400);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => '?').join(',');
      rows.push(...await this.client.query<CandidateRow>(
        `SELECT item.id AS memory_id, revision.id AS revision_id, revision.revision_no,
                item.canonical_key, item.kind, item.state, item.enforcement, item.importance, item.pinned,
                revision.value_text, revision.source_event_id, item.created_at, item.updated_at,
                item.last_accessed_at, item.access_count
           FROM memory_items AS item
           JOIN memory_revisions AS revision ON revision.id = item.current_revision_id
          WHERE item.principal_id = ? AND IFNULL(item.project_id, '') = ?
            AND ${statePredicate(Boolean(request.includeHistory))}
            AND item.id IN (${placeholders})
          ORDER BY item.id COLLATE BINARY`,
        [request.scope.principalId, scopeProject(request.scope), ...chunk],
      ));
    }
    return rows.sort((a, b) => a.memory_id.localeCompare(b.memory_id));
  }

  private async loadAnchors(memoryIds: string[]): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    for (let offset = 0; offset < memoryIds.length; offset += 400) {
      const chunk = memoryIds.slice(offset, offset + 400);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => '?').join(',');
      const rows = await this.client.query<{ memory_id: string; anchor: string }>(
        `SELECT memory_id, anchor FROM memory_anchors
          WHERE memory_id IN (${placeholders})
          ORDER BY memory_id COLLATE BINARY, anchor COLLATE BINARY`,
        chunk,
      );
      for (const row of rows) {
        const list = result.get(row.memory_id) ?? [];
        if (!list.includes(row.anchor)) list.push(row.anchor);
        result.set(row.memory_id, list);
      }
    }
    return result;
  }

  private computeRecencyAccess(rows: CandidateRow[]): Map<string, number> {
    const byRecent = [...rows].sort((left, right) => Number(right.updated_at) - Number(left.updated_at) || left.memory_id.localeCompare(right.memory_id));
    const maxAccess = Math.max(0, ...rows.map((row) => Number(row.access_count)));
    const result = new Map<string, number>();
    byRecent.forEach((row, index) => {
      const recency = byRecent.length <= 1 ? 1 : 1 - (index / (byRecent.length - 1));
      const access = maxAccess > 0 ? Math.min(1, Number(row.access_count) / maxAccess) : 0;
      result.set(row.memory_id, (0.75 * recency) + (0.25 * access));
    });
    return result;
  }
}
