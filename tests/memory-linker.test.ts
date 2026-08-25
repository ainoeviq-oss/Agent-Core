import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryLinker, RELATION_WEIGHTS, derivePairRelations } from '../src/memory/linker.js';
import { MemoryStore } from '../src/memory/store.js';
import { MemoryWorkerClient } from '../src/memory/worker-client.js';

function tempDb(): string {
  const base = process.env.TEMP || process.env.TMP || os.tmpdir();
  return path.join(mkdtempSync(path.join(base, 'agent-core-linker-')), 'memory.sqlite');
}

describe('deterministic evidence graph linker', () => {
  it('uses only declared relation classes and exact weights', () => {
    const left = {
      memoryId: 'a', canonicalKey: 'same.key', valueText: 'deterministic memory graph routing state',
      anchors: [
        { type: 'windows_path', value: 'F:\\Projects\\Agent-Core' },
        { type: 'route_id', value: 'route_alpha123' },
      ],
      sourceEventId: 'event-shared', threadId: 'thread-1', resourceId: 'resource-1', createdAt: 1000,
    };
    const right = {
      memoryId: 'b', canonicalKey: 'same.key', valueText: 'deterministic memory graph retrieval state',
      anchors: [
        { type: 'windows_path', value: 'F:\\Projects\\Agent-Core' },
        { type: 'route_id', value: 'route_alpha123' },
      ],
      sourceEventId: 'event-shared', threadId: 'thread-1', resourceId: 'resource-2', createdAt: 1200,
    };
    const relations = derivePairRelations(left, right, {
      tokenOverlapJaccardThreshold: 0.35,
      temporalNeighborWindowMs: 1000,
      structuredRelations: ['supersedes', 'explicit_relation'],
    });
    const byType = Object.fromEntries(relations.map((relation) => [relation.relation, relation.weight]));
    expect(byType).toMatchObject({
      same_key: 1,
      supersedes: 1,
      explicit_relation: 1,
      same_anchor: 0.95,
      same_artifact: 0.90,
      same_route_or_task: 0.80,
      cooccurs_in_event: 0.60,
    });
    expect(byType.token_overlap).toBeGreaterThanOrEqual(0.20);
    expect(byType.token_overlap).toBeLessThanOrEqual(0.55);
    expect(byType.temporal_neighbor).toBeGreaterThanOrEqual(0.15);
    expect(byType.temporal_neighbor).toBeLessThanOrEqual(0.30);
    expect(RELATION_WEIGHTS).toMatchObject({ same_key: 1, supersedes: 1, explicit_relation: 1, same_anchor: 0.95, same_artifact: 0.90, same_route_or_task: 0.80, cooccurs_in_event: 0.60 });
  });

  it('persists idempotent evidence edges and never links unrelated prose by semantic vibe', async () => {
    const client = new MemoryWorkerClient();
    const store = new MemoryStore(client);
    await store.open({ dbPath: tempDb() });

    const base = { principalId: 'p1', projectId: 'project-a' };
    const artifactA = await store.commitMemory({
      scope: { ...base, threadId: 'thread-a', resourceId: 'resource-a' },
      canonicalKey: 'artifact.primary', kind: 'artifact',
      value: 'Primary artifact at "F:\\Projects\\Agent Core\\Design Files".', sourceType: 'test',
    });
    const artifactB = await store.commitMemory({
      scope: { ...base, threadId: 'thread-b', resourceId: 'resource-b' },
      canonicalKey: 'artifact.backup', kind: 'artifact',
      value: 'Backup artifact at "F:\\Projects\\Agent Core\\Design Files" route_beta123.', sourceType: 'test',
    });
    const unrelated = await store.commitMemory({
      scope: { ...base, threadId: 'thread-c', resourceId: 'resource-c' },
      canonicalKey: 'note.coffee', kind: 'observation',
      value: 'Coffee beans roast slowly beside a ceramic cup.', sourceType: 'test',
    });

    const linker = new MemoryLinker(client, {
      tokenOverlapJaccardThreshold: 0.35,
      temporalNeighborWindowMs: 30 * 60 * 1000,
      candidateCap: 128,
    });
    const first = await linker.linkMemory(base, artifactB.memoryId);
    expect(first.createdEdges).toBeGreaterThanOrEqual(4);
    const countAfterFirst = (await client.query<{ count: number }>('SELECT count(*) AS count FROM memory_edges'))[0]!.count;
    const second = await linker.linkMemory(base, artifactB.memoryId);
    const countAfterSecond = (await client.query<{ count: number }>('SELECT count(*) AS count FROM memory_edges'))[0]!.count;
    expect(second.createdEdges).toBe(0);
    expect(countAfterSecond).toBe(countAfterFirst);

    const artifactEdges = await client.query<{ relation: string; weight: number; evidence_event_id: string | null }>(
      `SELECT relation, weight, evidence_event_id FROM memory_edges
       WHERE (from_memory_id = ? AND to_memory_id = ?) OR (from_memory_id = ? AND to_memory_id = ?)
       ORDER BY relation, from_memory_id`,
      [artifactA.memoryId, artifactB.memoryId, artifactB.memoryId, artifactA.memoryId],
    );
    expect(artifactEdges.some((edge) => edge.relation === 'same_anchor' && edge.weight === 0.95)).toBe(true);
    expect(artifactEdges.some((edge) => edge.relation === 'same_artifact' && edge.weight === 0.90)).toBe(true);
    expect(artifactEdges.every((edge) => typeof edge.evidence_event_id === 'string')).toBe(true);

    const unrelatedEdges = await client.query(
      `SELECT relation FROM memory_edges
       WHERE (from_memory_id = ? AND to_memory_id = ?) OR (from_memory_id = ? AND to_memory_id = ?)`,
      [artifactB.memoryId, unrelated.memoryId, unrelated.memoryId, artifactB.memoryId],
    );
    expect(unrelatedEdges).toEqual([]);
    await store.close();
  });
});
