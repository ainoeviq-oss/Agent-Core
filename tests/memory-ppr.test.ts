import { describe, expect, it } from 'vitest';
import { runPersonalizedPageRank } from '../src/memory/ppr.js';

describe('bounded deterministic personalized PageRank', () => {
  it('ranks a known two-node cycle deterministically with the configured defaults', () => {
    const input = {
      nodes: ['b', 'a'],
      edges: [
        { from: 'a', to: 'b', weight: 1 },
        { from: 'b', to: 'a', weight: 1 },
      ],
      personalization: new Map([['a', 1]]),
    };
    const first = runPersonalizedPageRank(input);
    const second = runPersonalizedPageRank(input);
    expect(second).toEqual(first);
    expect(first.options).toEqual({ damping: 0.85, epsilon: 1e-6, maxIterations: 20 });
    expect(first.ranking.map((row) => row.memoryId)).toEqual(['a', 'b']);
    expect(first.ranking[0]!.score).toBeGreaterThan(first.ranking[1]!.score);
    expect(first.ranking[0]!.score + first.ranking[1]!.score).toBeCloseTo(1, 10);
    expect(first.ranking[0]!.score).toBeCloseTo(1 / 1.85, 1);
  });

  it('handles dangling, disconnected, cycles, stable ties, duplicate edges, and deterministic truncation', () => {
    const result = runPersonalizedPageRank({
      nodes: ['z', 'b', 'a', 'c'],
      edges: [
        { from: 'a', to: 'b', weight: 1 },
        { from: 'a', to: 'b', weight: 1 },
        { from: 'b', to: 'c', weight: 2 },
        { from: 'c', to: 'a', weight: 1 },
        { from: 'z', to: 'z', weight: 1 },
      ],
      personalization: new Map([['a', 1], ['z', 0]]),
      maxNodes: 3,
    });
    expect(result.graphTruncated).toBe(true);
    expect(result.nodeIds).toEqual(['a', 'b', 'c']);
    expect(result.ranking).toHaveLength(3);
    expect(result.ranking.every((row) => Number.isFinite(row.score) && row.score >= 0)).toBe(true);
    expect(result.ranking.reduce((sum, row) => sum + row.score, 0)).toBeCloseTo(1, 10);

    const tie = runPersonalizedPageRank({
      nodes: ['b', 'a'],
      edges: [],
      personalization: new Map([['a', 1], ['b', 1]]),
    });
    expect(tie.ranking[0]!.score).toBe(tie.ranking[1]!.score);
    expect(tie.ranking.map((row) => row.memoryId)).toEqual(['a', 'b']);
  });
});
