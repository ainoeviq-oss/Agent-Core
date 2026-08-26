import type { MemoryPreflightResult, MemorySearchHit } from '../memory/types.js';

export interface MemoryRoutingInjectionOptions {
  maxItems?: number;
  characterBudget?: number;
}

export interface MemoryRoutingInjection {
  context: string;
  applied: boolean;
  memoryIds: string[];
  characterCount: number;
  omittedCount: number;
}

const DEFAULT_MAX_ITEMS = 6;
const DEFAULT_CHARACTER_BUDGET = 2_400;

function normalizedText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function prioritizedRoutingHits(preflight: MemoryPreflightResult): MemorySearchHit[] {
  const ordered = [
    ...preflight.relatedDecisions,
    ...preflight.priorFailures,
    ...preflight.recalled.filter((hit) => hit.kind !== 'guardrail'),
  ];
  const seen = new Set<string>();
  return ordered.filter((hit) => {
    if (seen.has(hit.memoryId)) return false;
    seen.add(hit.memoryId);
    return true;
  });
}

function renderHit(hit: MemorySearchHit): string {
  const key = normalizedText(hit.canonicalKey);
  const value = normalizedText(hit.valueText);
  return `[${hit.kind}:${key}] ${value}`;
}

/**
 * Project a bounded deterministic subset of recalled memory into capability-routing context.
 * Hard guardrails are intentionally excluded here because they are enforced separately by
 * RouteContextStore rather than being treated as capability-ranking hints.
 */
export function injectMemoryIntoRoutingContext(
  context: string | undefined,
  preflight: MemoryPreflightResult | null,
  options: MemoryRoutingInjectionOptions = {},
): MemoryRoutingInjection {
  const originalContext = context?.normalize('NFKC').trim() ?? '';
  if (!preflight) {
    return { context: originalContext, applied: false, memoryIds: [], characterCount: 0, omittedCount: 0 };
  }

  const maxItems = Math.max(1, Math.min(options.maxItems ?? DEFAULT_MAX_ITEMS, 24));
  const characterBudget = Math.max(256, Math.min(options.characterBudget ?? DEFAULT_CHARACTER_BUDGET, 12_000));
  const candidates = prioritizedRoutingHits(preflight);
  const lines: string[] = [];
  const memoryIds: string[] = [];
  let characters = 0;

  for (const hit of candidates) {
    if (lines.length >= maxItems) break;
    let line = renderHit(hit);
    const remaining = characterBudget - characters;
    if (remaining <= 0) break;
    if (line.length > remaining) line = `${line.slice(0, Math.max(0, remaining - 1)).trimEnd()}…`;
    if (!line) break;
    lines.push(line);
    memoryIds.push(hit.memoryId);
    characters += line.length;
  }

  if (lines.length === 0) {
    return {
      context: originalContext,
      applied: false,
      memoryIds: [],
      characterCount: 0,
      omittedCount: candidates.length,
    };
  }

  const recalledContext = lines.join('\n');
  return {
    context: [originalContext, recalledContext].filter(Boolean).join('\n'),
    applied: true,
    memoryIds,
    characterCount: recalledContext.length,
    omittedCount: Math.max(0, candidates.length - memoryIds.length),
  };
}
