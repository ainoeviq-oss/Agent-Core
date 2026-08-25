import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { combineMemoryScore } from '../src/memory/scoring.js';
import { MemoryRetriever } from '../src/memory/retriever.js';
import { MemoryStore } from '../src/memory/store.js';
import { MemoryWorkerClient } from '../src/memory/worker-client.js';

function tempDb(): string {
  const base = process.env.TEMP || process.env.TMP || os.tmpdir();
  return path.join(mkdtempSync(path.join(base, 'agent-core-retriever-')), 'memory.sqlite');
}

describe('deterministic hybrid memory retriever', () => {
  it('combines normalized components using the configured Section 11 weights', () => {
    const weights = loadConfig({}, process.cwd()).memory.scoreWeights;
    const result = combineMemoryScore({
      lexical: 1,
      exact: 0.5,
      graph: 0.25,
      state: 1,
      importance: 0.5,
      recency: 0.2,
    }, weights);
    expect(result).toBeCloseTo(0.675, 12);
  });

  it('unions exact/FTS seeds, expands graph evidence, hard-includes guardrails, and is reproducible', async () => {
    const client = new MemoryWorkerClient();
    const store = new MemoryStore(client);
    const dbPath = tempDb();
    await store.open({ dbPath });
    const scope = { principalId: 'principal-a', projectId: 'project-a' };

    const guardrail = await store.commitMemory({
      scope,
      canonicalKey: 'policy.workspace.output',
      kind: 'guardrail',
      value: 'Build output must remain inside F:\\Projects\\Agent-Core and must not be written to C:\\Windows.',
      importance: 1,
      pinned: true,
      enforcement: 'hard',
      sourceType: 'test',
    });
    const artifact = await store.commitMemory({
      scope,
      canonicalKey: 'artifact.route.proof',
      kind: 'artifact',
      value: 'Route proof artifact lives at F:\\Projects\\Agent-Core\\runtime\\proof.txt.',
      importance: 0.8,
      sourceType: 'test',
    });
    const decision = await store.commitMemory({
      scope,
      canonicalKey: 'decision.route.proof.renderer',
      kind: 'decision',
      value: 'Use TypeScript renderer for the route proof artifact.',
      importance: 0.9,
      sourceType: 'test',
      explicitRelations: [{ targetMemoryId: artifact.memoryId, relation: 'explicit_relation' }],
    });
    await store.commitMemory({
      scope,
      canonicalKey: 'note.unrelated.coffee',
      kind: 'observation',
      value: 'Coffee beans roast slowly beside a ceramic cup.',
      sourceType: 'test',
    });
    const foreign = await store.commitMemory({
      scope: { principalId: 'principal-b', projectId: 'project-a' },
      canonicalKey: 'decision.route.proof.foreign',
      kind: 'decision',
      value: 'Foreign TypeScript route proof must never cross principal scope.',
      sourceType: 'test',
    });

    const config = loadConfig({}, process.cwd()).memory;
    const retriever = new MemoryRetriever(client, config);
    const request = {
      scope,
      query: 'TypeScript build output route proof F:\\Projects\\Agent-Core',
      limit: 3,
      characterBudget: 4000,
    };
    const first = await retriever.search(request);
    const second = await retriever.search(request);

    expect(second).toEqual(first);
    expect(first.graphTruncated).toBe(false);
    expect(first.hits).toHaveLength(3);
    expect(first.hits[0]!.memoryId).toBe(guardrail.memoryId);
    expect(first.hits[0]!.kind).toBe('guardrail');
    expect(first.hits[0]!.enforcement).toBe('hard');
    expect(first.hits.map((hit) => hit.memoryId)).toContain(decision.memoryId);
    expect(first.hits.map((hit) => hit.memoryId)).toContain(artifact.memoryId);
    expect(first.hits.map((hit) => hit.memoryId)).not.toContain(foreign.memoryId);
    expect(first.hits.every((hit) => hit.whyMatched.finalScore >= 0 && hit.whyMatched.finalScore <= 1)).toBe(true);
    expect(first.hits.some((hit) => hit.whyMatched.matchedAnchors.some((anchor) => anchor.includes('F:\\Projects\\Agent-Core')))).toBe(true);
    expect(first.hits.some((hit) => (hit.whyMatched.graphPath?.length ?? 0) >= 2)).toBe(true);
    expect(first.hits.some((hit) => (hit.whyMatched.lexicalTerms?.length ?? 0) > 0)).toBe(true);
    expect(first.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.hits.reduce((total, hit) => total + hit.valueText.length, 0)).toBeLessThanOrEqual(4000);

    await store.close();
  });
});
