export interface PageRankEdge {
  from: string;
  to: string;
  weight: number;
}

export interface PersonalizedPageRankInput {
  nodes: readonly string[];
  edges: readonly PageRankEdge[];
  personalization?: ReadonlyMap<string, number>;
  damping?: number;
  epsilon?: number;
  maxIterations?: number;
  maxNodes?: number;
  maxEdges?: number;
}

export interface PageRankScore {
  memoryId: string;
  score: number;
}

export interface PersonalizedPageRankResult {
  nodeIds: string[];
  ranking: PageRankScore[];
  iterations: number;
  converged: boolean;
  graphTruncated: boolean;
  options: {
    damping: number;
    epsilon: number;
    maxIterations: number;
  };
}

const DEFAULT_DAMPING = 0.85;
const DEFAULT_EPSILON = 1e-6;
const DEFAULT_MAX_ITERATIONS = 20;

function stableUnique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort((a, b) => a.localeCompare(b));
}

function finitePositive(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? value! : 0;
}

function chooseBoundedNodes(
  allNodes: readonly string[],
  edges: readonly PageRankEdge[],
  personalization: ReadonlyMap<string, number>,
  maxNodes: number,
): { nodeIds: string[]; truncated: boolean } {
  if (allNodes.length <= maxNodes) return { nodeIds: [...allNodes], truncated: false };

  const nodeSet = new Set(allNodes);
  const adjacency = new Map<string, Set<string>>();
  for (const node of allNodes) adjacency.set(node, new Set());
  for (const edge of edges) {
    if (!nodeSet.has(edge.from) || !nodeSet.has(edge.to) || finitePositive(edge.weight) === 0) continue;
    adjacency.get(edge.from)!.add(edge.to);
    adjacency.get(edge.to)!.add(edge.from);
  }

  const positiveSeeds = allNodes
    .filter((node) => finitePositive(personalization.get(node)) > 0)
    .sort((left, right) => {
      const delta = finitePositive(personalization.get(right)) - finitePositive(personalization.get(left));
      return delta !== 0 ? delta : left.localeCompare(right);
    });
  const initial = positiveSeeds.length > 0 ? positiveSeeds : [...allNodes];
  const selected: string[] = [];
  const seen = new Set<string>();
  const queue = [...initial];

  while (queue.length > 0 && selected.length < maxNodes) {
    const node = queue.shift()!;
    if (seen.has(node) || !nodeSet.has(node)) continue;
    seen.add(node);
    selected.push(node);
    const neighbors = [...(adjacency.get(node) ?? [])].sort((a, b) => a.localeCompare(b));
    for (const neighbor of neighbors) {
      if (!seen.has(neighbor)) queue.push(neighbor);
    }
  }

  if (selected.length < maxNodes) {
    for (const node of allNodes) {
      if (selected.length >= maxNodes) break;
      if (!seen.has(node)) {
        seen.add(node);
        selected.push(node);
      }
    }
  }

  return { nodeIds: selected, truncated: selected.length < allNodes.length };
}

export function runPersonalizedPageRank(input: PersonalizedPageRankInput): PersonalizedPageRankResult {
  const damping = input.damping ?? DEFAULT_DAMPING;
  const epsilon = input.epsilon ?? DEFAULT_EPSILON;
  const maxIterations = input.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const maxNodes = input.maxNodes ?? Number.POSITIVE_INFINITY;
  const maxEdges = input.maxEdges ?? Number.POSITIVE_INFINITY;

  if (!(damping >= 0 && damping < 1)) throw new Error('PPR damping must be >= 0 and < 1');
  if (!(epsilon > 0 && Number.isFinite(epsilon))) throw new Error('PPR epsilon must be a finite positive number');
  if (!Number.isInteger(maxIterations) || maxIterations < 1) throw new Error('PPR maxIterations must be a positive integer');
  if (!(maxNodes >= 1)) throw new Error('PPR maxNodes must be at least 1');
  if (!(maxEdges >= 0)) throw new Error('PPR maxEdges must be non-negative');

  const allNodes = stableUnique(input.nodes);
  if (allNodes.length === 0) {
    return {
      nodeIds: [],
      ranking: [],
      iterations: 0,
      converged: true,
      graphTruncated: false,
      options: { damping, epsilon, maxIterations },
    };
  }

  const personalization = input.personalization ?? new Map<string, number>();
  const bounded = chooseBoundedNodes(allNodes, input.edges, personalization, Math.min(maxNodes, allNodes.length));
  const nodeIds = bounded.nodeIds;
  const nodeSet = new Set(nodeIds);

  const edgeWeights = new Map<string, Map<string, number>>();
  for (const node of nodeIds) edgeWeights.set(node, new Map());
  for (const edge of input.edges) {
    const weight = finitePositive(edge.weight);
    if (weight === 0 || !nodeSet.has(edge.from) || !nodeSet.has(edge.to)) continue;
    const targets = edgeWeights.get(edge.from)!;
    targets.set(edge.to, (targets.get(edge.to) ?? 0) + weight);
  }

  const flattened = [...edgeWeights.entries()]
    .flatMap(([from, targets]) => [...targets.entries()].map(([to, weight]) => ({ from, to, weight })))
    .sort((left, right) => left.from.localeCompare(right.from) || right.weight - left.weight || left.to.localeCompare(right.to));
  const keptEdges = flattened.slice(0, Math.min(maxEdges, flattened.length));
  const truncatedByEdges = keptEdges.length < flattened.length;

  const outgoing = new Map<string, Array<{ to: string; probability: number }>>();
  for (const node of nodeIds) outgoing.set(node, []);
  const totals = new Map<string, number>();
  for (const edge of keptEdges) totals.set(edge.from, (totals.get(edge.from) ?? 0) + edge.weight);
  for (const edge of keptEdges) {
    const total = totals.get(edge.from)!;
    outgoing.get(edge.from)!.push({ to: edge.to, probability: edge.weight / total });
  }
  for (const list of outgoing.values()) list.sort((a, b) => a.to.localeCompare(b.to));

  const teleport = new Map<string, number>();
  let teleportTotal = 0;
  for (const node of nodeIds) {
    const value = finitePositive(personalization.get(node));
    teleport.set(node, value);
    teleportTotal += value;
  }
  if (teleportTotal === 0) {
    const uniform = 1 / nodeIds.length;
    for (const node of nodeIds) teleport.set(node, uniform);
  } else {
    for (const node of nodeIds) teleport.set(node, teleport.get(node)! / teleportTotal);
  }

  let scores = new Map<string, number>(teleport);
  let converged = false;
  let iterations = 0;

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const next = new Map<string, number>();
    for (const node of nodeIds) next.set(node, (1 - damping) * teleport.get(node)!);

    let danglingMass = 0;
    for (const node of nodeIds) {
      const score = scores.get(node) ?? 0;
      const transitions = outgoing.get(node)!;
      if (transitions.length === 0) {
        danglingMass += score;
        continue;
      }
      for (const transition of transitions) {
        next.set(transition.to, next.get(transition.to)! + damping * score * transition.probability);
      }
    }

    if (danglingMass > 0) {
      for (const node of nodeIds) {
        next.set(node, next.get(node)! + damping * danglingMass * teleport.get(node)!);
      }
    }

    const total = [...next.values()].reduce((sum, value) => sum + value, 0);
    if (total > 0) {
      for (const node of nodeIds) next.set(node, next.get(node)! / total);
    }

    const delta = nodeIds.reduce((sum, node) => sum + Math.abs((next.get(node) ?? 0) - (scores.get(node) ?? 0)), 0);
    scores = next;
    iterations = iteration;
    if (delta <= epsilon) {
      converged = true;
      break;
    }
  }

  const ranking = nodeIds
    .map((memoryId) => ({ memoryId, score: scores.get(memoryId) ?? 0 }))
    .sort((left, right) => right.score - left.score || left.memoryId.localeCompare(right.memoryId));

  return {
    nodeIds,
    ranking,
    iterations,
    converged,
    graphTruncated: bounded.truncated || truncatedByEdges,
    options: { damping, epsilon, maxIterations },
  };
}
