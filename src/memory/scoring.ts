import type { MemoryScoreWeights } from '../config.js';
import type { MemoryEnforcement, MemoryKind, MemoryState } from './types.js';

export interface MemoryScoreComponents {
  lexical: number;
  exact: number;
  graph: number;
  state: number;
  importance: number;
  recency: number;
}

export function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function combineMemoryScore(
  components: MemoryScoreComponents,
  weights: MemoryScoreWeights,
): number {
  return clampUnit(
    clampUnit(components.lexical) * weights.lexical
    + clampUnit(components.exact) * weights.exact
    + clampUnit(components.graph) * weights.graph
    + clampUnit(components.state) * weights.state
    + clampUnit(components.importance) * weights.importance
    + clampUnit(components.recency) * weights.recency,
  );
}

export function memoryStateScore(
  kind: MemoryKind,
  state: MemoryState,
  enforcement: MemoryEnforcement,
): number {
  if (state === 'tombstoned') return 0;
  if (state === 'active' && kind === 'guardrail' && enforcement === 'hard') return 1;
  if (state === 'active' && kind === 'guardrail') return 0.9;
  if (state === 'active') return 0.6;
  if (state === 'conflicted') return 0.45;
  if (state === 'completed') return 0.25;
  if (state === 'archived') return 0.1;
  if (state === 'superseded') return 0.05;
  return 0;
}

export function memoryImportanceScore(importance: number, pinned: boolean): number {
  return pinned ? 1 : clampUnit(importance);
}
