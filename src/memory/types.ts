export const MEMORY_KINDS = [
  'fact',
  'preference',
  'guardrail',
  'decision',
  'goal',
  'task',
  'artifact',
  'procedure',
  'tool_state',
  'project_state',
  'failure',
  'observation',
  'relationship',
] as const;

export const MEMORY_STATES = [
  'active',
  'superseded',
  'completed',
  'archived',
  'tombstoned',
  'conflicted',
] as const;

export const MEMORY_RELATIONS = [
  'same_key',
  'supersedes',
  'explicit_relation',
  'same_anchor',
  'same_artifact',
  'same_route_or_task',
  'cooccurs_in_event',
  'token_overlap',
  'temporal_neighbor',
] as const;

export const MEMORY_ENFORCEMENTS = ['none', 'soft', 'hard'] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type MemoryState = (typeof MEMORY_STATES)[number];
export type MemoryRelation = (typeof MEMORY_RELATIONS)[number];
export type MemoryEnforcement = (typeof MEMORY_ENFORCEMENTS)[number];

export type MemoryId = string;
export type MemoryRevisionId = string;
export type MemoryEventId = string;
export type MemoryContextId = string;

export interface MemoryScope {
  principalId: string;
  projectId?: string;
  threadId?: string;
  resourceId?: string;
}

export interface MemoryExplicitRelation {
  targetMemoryId: MemoryId;
  relation: MemoryRelation;
  weight?: number;
}

export interface MemoryCommitRequest {
  scope: MemoryScope;
  canonicalKey: string;
  kind: MemoryKind;
  value: string | number | boolean | null | Record<string, unknown> | unknown[];
  importance?: number;
  pinned?: boolean;
  enforcement?: MemoryEnforcement;
  sourceType?: string;
  sourceRef?: string;
  metadata?: Record<string, unknown>;
  explicitRelations?: MemoryExplicitRelation[];
}

export interface MemoryCommitResult {
  memoryId: MemoryId;
  revisionId: MemoryRevisionId;
  eventId: MemoryEventId;
  revisionNo: number;
  deduplicated: boolean;
  state: MemoryState;
}

export interface MemoryReviseRequest {
  scope: MemoryScope;
  memoryId: MemoryId;
  value: MemoryCommitRequest['value'];
  sourceType?: string;
  sourceRef?: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryReviseResult extends MemoryCommitResult {
  supersededRevisionId?: MemoryRevisionId;
}

export interface MemorySearchRequest {
  scope: MemoryScope;
  query: string;
  includeHistory?: boolean;
  limit?: number;
  characterBudget?: number;
}

export interface MemoryScoreExplanation {
  lexical: number;
  exact: number;
  graph: number;
  state: number;
  importance: number;
  recency: number;
  finalScore: number;
  matchedAnchors: string[];
  graphPath?: MemoryId[];
}

export interface MemorySearchHit {
  memoryId: MemoryId;
  revisionId: MemoryRevisionId;
  revisionNo: number;
  canonicalKey: string;
  kind: MemoryKind;
  state: MemoryState;
  enforcement: MemoryEnforcement;
  importance: number;
  pinned: boolean;
  valueText: string;
  sourceEventId?: MemoryEventId;
  createdAt: number;
  updatedAt: number;
  whyMatched: MemoryScoreExplanation;
}

export interface MemorySearchResult {
  query: string;
  hits: MemorySearchHit[];
  graphTruncated: boolean;
  snapshotHash: string;
}

export interface MemoryPreflightRequest {
  scope: MemoryScope;
  routeContextId: string;
  task: string;
  context?: string;
  expiresAt: number;
}

export interface MemoryGuardrailDecision {
  blocked: boolean;
  guardrailMemoryIds: MemoryId[];
  reasons: string[];
}

export interface MemoryPreflightResult {
  contextId: MemoryContextId;
  queryText: string;
  snapshotHash: string;
  recalled: MemorySearchHit[];
  blocking: MemoryGuardrailDecision;
  expiresAt: number;
}

export interface MemoryExplainRequest {
  scope: MemoryScope;
  memoryId: MemoryId;
  contextId?: MemoryContextId;
}

export interface MemoryExplainResult {
  memoryId: MemoryId;
  revisions: Array<{
    revisionId: MemoryRevisionId;
    revisionNo: number;
    valueText: string;
    sourceEventId?: MemoryEventId;
    validFrom: number;
    validTo?: number;
  }>;
  anchors: string[];
  edges: Array<{
    fromMemoryId: MemoryId;
    toMemoryId: MemoryId;
    relation: MemoryRelation;
    weight: number;
    evidenceEventId?: MemoryEventId;
  }>;
  accessReasons: MemoryScoreExplanation[];
}

export interface MemoryStatus {
  enabled: boolean;
  healthy: boolean;
  schemaVersion: number;
  dbPath: string;
  counts: Record<string, number>;
  integrity: string;
}
