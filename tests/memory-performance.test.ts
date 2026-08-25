import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { runPersonalizedPageRank } from '../src/memory/ppr.js';

describe('deterministic memory performance boundaries', () => {
  it('keeps the production graph and PPR defaults bounded exactly as the master contract requires', () => {
    const config = loadConfig({}, process.cwd()).memory;
    expect(config.graphNodeCap).toBe(1000);
    expect(config.graphEdgeCap).toBe(10_000);
    expect(config.graphMaxHops).toBe(2);
    expect(config.pprDamping).toBe(0.85);
    expect(config.pprEpsilon).toBe(1e-6);
    expect(config.pprMaxIterations).toBe(20);
  });

  it('hard-caps a synthetic PPR graph without changing deterministic ordering', () => {
    const config = loadConfig({}, process.cwd()).memory;
    const nodes = Array.from({ length: 1_250 }, (_, index) => `node-${String(index).padStart(4, '0')}`);
    const edges = nodes.slice(1).flatMap((node) => [
      { from: nodes[0]!, to: node, weight: 1 },
      { from: node, to: nodes[0]!, weight: 1 },
    ]);
    const input = {
      nodes,
      edges,
      personalization: new Map([[nodes[0]!, 1]]),
      damping: config.pprDamping,
      epsilon: config.pprEpsilon,
      maxIterations: config.pprMaxIterations,
      maxNodes: config.graphNodeCap,
      maxEdges: config.graphEdgeCap,
    };
    const first = runPersonalizedPageRank(input);
    const second = runPersonalizedPageRank(input);

    expect(first.graphTruncated).toBe(true);
    expect(first.nodeIds.length).toBeLessThanOrEqual(config.graphNodeCap);
    expect(first.iterations).toBeLessThanOrEqual(config.pprMaxIterations);
    expect(first.ranking.map((item) => item.memoryId)).toEqual(second.ranking.map((item) => item.memoryId));
    expect(first.ranking.map((item) => item.score)).toEqual(second.ranking.map((item) => item.score));
  });
});
