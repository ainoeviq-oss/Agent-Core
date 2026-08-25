import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { MemoryLifecycle } from '../src/memory/lifecycle.js';
import { MemoryLinker } from '../src/memory/linker.js';
import { MemoryRetriever } from '../src/memory/retriever.js';
import { MemoryStore, MemoryStoreError } from '../src/memory/store.js';
import { MemoryWorkerClient } from '../src/memory/worker-client.js';

function tempDb(): string {
  const base = process.env.TEMP || process.env.TMP || os.tmpdir();
  return path.join(mkdtempSync(path.join(base, 'agent-core-lifecycle-')), 'memory.sqlite');
}

describe('safe deterministic memory lifecycle', () => {
  it('requires explicit revision authority and opens ambiguous conflicts instead of overwriting', async () => {
    const client = new MemoryWorkerClient();
    const store = new MemoryStore(client);
    await store.open({ dbPath: tempDb() });
    const scope = { principalId: 'principal-a', projectId: 'project-a' };

    const decision = await store.commitMemory({
      scope,
      canonicalKey: 'decision.renderer',
      kind: 'decision',
      value: 'Use renderer A',
      sourceType: 'test',
    });
    await expect(store.commitMemory({
      scope,
      canonicalKey: 'decision.renderer',
      kind: 'decision',
      value: 'Use renderer B',
      sourceType: 'test',
    })).rejects.toEqual(expect.objectContaining<Partial<MemoryStoreError>>({ code: 'MEMORY_REVISION_REQUIRED' }));

    const revised = await store.reviseMemory({
      scope,
      memoryId: decision.memoryId,
      value: 'Use renderer B',
      sourceType: 'user_correction',
    });
    expect(revised.revisionNo).toBe(2);

    const observation = await store.commitMemory({
      scope,
      canonicalKey: 'observation.freeform.one',
      kind: 'observation',
      value: 'The deployment behavior looked different in one run.',
      sourceType: 'test',
    });
    await expect(store.reviseMemory({
      scope,
      memoryId: observation.memoryId,
      value: 'overwrite observation',
      sourceType: 'test',
    })).rejects.toMatchObject({ code: 'MEMORY_KIND_IMMUTABLE' });

    const other = await store.commitMemory({
      scope,
      canonicalKey: 'observation.freeform.two',
      kind: 'observation',
      value: 'A separate run produced evidence that may conflict.',
      sourceType: 'test',
    });
    const lifecycle = new MemoryLifecycle(client, loadConfig({}, process.cwd()).memory);
    const conflict = await lifecycle.openConflict(scope, observation.memoryId, other.memoryId, 'ambiguous_freeform', {
      reason: 'Primary AI surfaced ambiguity; deterministic code must preserve both branches.',
    });
    expect(conflict.status).toBe('open');
    expect(new Set([conflict.leftMemoryId, conflict.rightMemoryId])).toEqual(new Set([observation.memoryId, other.memoryId]));
    expect((await store.getMemory(scope, observation.memoryId))!.state).toBe('conflicted');
    expect((await store.getMemory(scope, other.memoryId))!.state).toBe('conflicted');
    expect(await lifecycle.listOpenConflicts(scope)).toHaveLength(1);
    await expect(lifecycle.openConflict(
      { principalId: 'principal-b', projectId: 'project-a' }, observation.memoryId, other.memoryId, 'cross_scope', {},
    )).rejects.toThrow(/scope/i);
    await store.close();
  });

  it('archives only eligible observations, cleans inactive edges, and keeps an old pinned hard guardrail recallable', async () => {
    const client = new MemoryWorkerClient();
    const store = new MemoryStore(client);
    await store.open({ dbPath: tempDb() });
    const scope = { principalId: 'principal-a', projectId: 'project-a' };
    const config = loadConfig({}, process.cwd()).memory;
    const now = 2_000_000_000_000;
    const twoYears = 2 * 365 * 24 * 60 * 60 * 1000;

    const guardrail = await store.commitMemory({
      scope,
      canonicalKey: 'guardrail.storage',
      kind: 'guardrail',
      value: 'Workspace build output must stay on drive F.',
      importance: 1,
      pinned: true,
      enforcement: 'hard',
      sourceType: 'test',
    });
    const oldObservation = await store.commitMemory({
      scope,
      canonicalKey: 'observation.transient',
      kind: 'observation',
      value: 'Workspace build output transient note from an old scan at F:\\Projects\\Agent-Core\\dist.',
      importance: 0.2,
      sourceType: 'test',
    });
    const freshDecision = await store.commitMemory({
      scope,
      canonicalKey: 'decision.storage',
      kind: 'decision',
      value: 'Workspace build output uses the current packaging step.',
      importance: 0.8,
      sourceType: 'test',
    });
    const related = await store.commitMemory({
      scope,
      canonicalKey: 'artifact.related',
      kind: 'artifact',
      value: 'Workspace build output artifact record at F:\\Projects\\Agent-Core\\dist.',
      sourceType: 'test',
      explicitRelations: [{ targetMemoryId: oldObservation.memoryId, relation: 'explicit_relation' }],
    });

    const linker = new MemoryLinker(client, {
      tokenOverlapJaccardThreshold: config.tokenOverlapJaccardThreshold,
      temporalNeighborWindowMs: config.temporalNeighborWindowMs,
      candidateCap: 128,
    });
    await linker.linkMemory(scope, oldObservation.memoryId);
    expect((await client.query<{ count: number }>(
      'SELECT count(*) AS count FROM memory_edges WHERE from_memory_id = ? OR to_memory_id = ?',
      [oldObservation.memoryId, oldObservation.memoryId],
    ))[0]!.count).toBeGreaterThan(0);

    await client.transaction([
      { kind: 'run', sql: 'UPDATE memory_items SET updated_at = ?, last_accessed_at = ?, access_count = 0 WHERE id = ?', params: [now - twoYears, now - twoYears, guardrail.memoryId] },
      { kind: 'run', sql: 'UPDATE memory_items SET updated_at = ?, last_accessed_at = ?, access_count = 0 WHERE id = ?', params: [now - twoYears, now - twoYears, oldObservation.memoryId] },
      { kind: 'run', sql: 'UPDATE memory_items SET updated_at = ?, last_accessed_at = ? WHERE id IN (?, ?)', params: [now, now, freshDecision.memoryId, related.memoryId] },
    ]);

    const lifecycle = new MemoryLifecycle(client, config);
    const compacted = await lifecycle.compact(scope, now);
    expect(compacted.archivedMemoryIds).toEqual([oldObservation.memoryId]);
    expect((await store.getMemory(scope, oldObservation.memoryId))!.state).toBe('archived');
    expect((await store.getMemory(scope, guardrail.memoryId))!.state).toBe('active');
    expect((await client.query<{ count: number }>(
      'SELECT count(*) AS count FROM memory_edges WHERE from_memory_id = ? OR to_memory_id = ?',
      [oldObservation.memoryId, oldObservation.memoryId],
    ))[0]!.count).toBe(0);
    expect(compacted.integrity).toBe('ok');

    const retriever = new MemoryRetriever(client, config);
    const recall = await retriever.search({ scope, query: 'workspace build output', limit: 4 });
    expect(recall.hits[0]!.memoryId).toBe(guardrail.memoryId);
    expect(recall.hits.map((hit) => hit.memoryId)).not.toContain(oldObservation.memoryId);

    const eventsBeforeForget = (await client.query<{ count: number }>('SELECT count(*) AS count FROM memory_events'))[0]!.count;
    await store.tombstoneMemory(scope, related.memoryId, 'obsolete artifact');
    const afterForget = await lifecycle.compact(scope, now + 1);
    expect(afterForget.cleanedEdges).toBeGreaterThanOrEqual(0);
    expect((await client.query<{ count: number }>('SELECT count(*) AS count FROM memory_events'))[0]!.count).toBeGreaterThan(eventsBeforeForget);
    expect((await retriever.search({ scope, query: 'artifact record', includeHistory: true })).hits.map((hit) => hit.memoryId)).not.toContain(related.memoryId);

    await store.close();
  });
});
