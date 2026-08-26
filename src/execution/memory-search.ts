import { performance } from 'node:perf_hooks';
import type { MemoryConfig } from '../config.js';
import type { MemoryConflictRecord } from '../memory/lifecycle.js';
import type {
  MemoryScope,
  MemorySearchHit,
  MemorySearchRequest,
  MemorySearchResult,
} from '../memory/types.js';

export interface ExecutionMemorySearchSource {
  readonly config: Pick<
    MemoryConfig,
    'enabled' | 'enforceHardGuardrails' | 'recallItemBudget' | 'recallCharacterBudget'
  >;
  search(request: MemorySearchRequest): Promise<MemorySearchResult>;
  listOpenConflicts(scope: MemoryScope): Promise<MemoryConflictRecord[]>;
}

export interface ExecutionMemorySearchNode {
  id: string;
  purpose: string;
}

export type ExecutionMemoryPreSearchStatus = 'disabled' | 'healthy' | 'degraded';

export interface ExecutionMemoryPreSearchResult {
  status: ExecutionMemoryPreSearchStatus;
  query: string;
  recalled: MemorySearchHit[];
  blockingGuardrails: MemorySearchHit[];
  priorFailures: MemorySearchHit[];
  relatedDecisions: MemorySearchHit[];
  openConflicts: MemoryConflictRecord[];
  blocked: boolean;
  inspectionRequired: boolean;
  snapshotHash: string | null;
  durationMs: number;
  degradedReason?: string;
}

const EXECUTION_RECALL_ITEM_BUDGET = 12;
const EXECUTION_RECALL_CHARACTER_BUDGET = 6_000;

function normalize(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

export function buildExecutionMemoryQuery(
  objective: string,
  nodes: readonly ExecutionMemorySearchNode[],
): string {
  const objectiveText = normalize(objective);
  const nodePurposes = [...nodes]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((node) => `node:${normalize(node.id)} ${normalize(node.purpose)}`)
    .filter((value) => value.trim() !== 'node:');
  return [objectiveText, ...nodePurposes].filter(Boolean).join('\n');
}

function hardGuardrail(hit: MemorySearchHit): boolean {
  return hit.kind === 'guardrail' && hit.state === 'active' && hit.enforcement === 'hard';
}

function safeReason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).normalize('NFKC').slice(0, 500);
}

function elapsed(startedAt: number): number {
  return Number((performance.now() - startedAt).toFixed(3));
}

export class ExecutionMemoryPreSearch {
  constructor(readonly memory: ExecutionMemorySearchSource) {}

  async run(
    scope: MemoryScope,
    objective: string,
    nodes: readonly ExecutionMemorySearchNode[],
  ): Promise<ExecutionMemoryPreSearchResult> {
    const query = buildExecutionMemoryQuery(objective, nodes);
    const startedAt = performance.now();
    if (!this.memory.config.enabled) {
      return {
        status: 'disabled',
        query,
        recalled: [],
        blockingGuardrails: [],
        priorFailures: [],
        relatedDecisions: [],
        openConflicts: [],
        blocked: false,
        inspectionRequired: false,
        snapshotHash: null,
        durationMs: elapsed(startedAt),
      };
    }

    const [searchOutcome, conflictsOutcome] = await Promise.allSettled([
      this.memory.search({
        scope,
        query,
        limit: Math.min(EXECUTION_RECALL_ITEM_BUDGET, this.memory.config.recallItemBudget),
        characterBudget: Math.min(EXECUTION_RECALL_CHARACTER_BUDGET, this.memory.config.recallCharacterBudget),
      }),
      this.memory.listOpenConflicts(scope),
    ]);

    if (searchOutcome.status === 'rejected') {
      return {
        status: 'degraded',
        query,
        recalled: [],
        blockingGuardrails: [],
        priorFailures: [],
        relatedDecisions: [],
        openConflicts: conflictsOutcome.status === 'fulfilled' ? conflictsOutcome.value : [],
        blocked: false,
        inspectionRequired: conflictsOutcome.status === 'fulfilled' && conflictsOutcome.value.length > 0,
        snapshotHash: null,
        durationMs: elapsed(startedAt),
        degradedReason: safeReason(searchOutcome.reason),
      };
    }

    const recalled = searchOutcome.value.hits;
    const blockingGuardrails = recalled.filter(hardGuardrail);
    const priorFailures = recalled.filter((hit) => hit.kind === 'failure');
    const relatedDecisions = recalled.filter((hit) => hit.kind === 'decision');
    const openConflicts = conflictsOutcome.status === 'fulfilled' ? conflictsOutcome.value : [];
    const degradedReason = conflictsOutcome.status === 'rejected'
      ? safeReason(conflictsOutcome.reason)
      : undefined;
    const status: ExecutionMemoryPreSearchStatus = degradedReason ? 'degraded' : 'healthy';
    const blocked = this.memory.config.enforceHardGuardrails && blockingGuardrails.length > 0;

    return {
      status,
      query,
      recalled,
      blockingGuardrails,
      priorFailures,
      relatedDecisions,
      openConflicts,
      blocked,
      inspectionRequired: recalled.length > 0 || openConflicts.length > 0,
      snapshotHash: searchOutcome.value.snapshotHash,
      durationMs: elapsed(startedAt),
      ...(degradedReason ? { degradedReason } : {}),
    };
  }
}
