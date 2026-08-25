import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryStore, MemoryStoreError } from '../src/memory/store.js';
import { MemoryWorkerClient } from '../src/memory/worker-client.js';

function dbPath(label: string): string {
  const base = process.env.TEMP || process.env.TMP || os.tmpdir();
  return path.join(mkdtempSync(path.join(base, `agent-core-store-${label}-`)), 'memory.sqlite');
}

const scopeA = { principalId: 'principal-a', projectId: 'project-one', threadId: 'thread-a', resourceId: 'resource-a' };
const scopeB = { principalId: 'principal-b', projectId: 'project-one', threadId: 'thread-b', resourceId: 'resource-b' };

describe('auditable versioned memory store', () => {
  it('appends redacted events and creates/deduplicates/revises/tombstones memory transactionally with principal isolation', async () => {
    const client = new MemoryWorkerClient();
    const store = new MemoryStore(client);
    await store.open({ dbPath: dbPath('core') });

    const event = await store.recordEvent({
      scope: scopeA,
      eventType: 'memory.event_recorded',
      sourceType: 'test',
      sourceRef: 'secret-fixture',
      text: 'Authorization: Bearer super-secret-token-value normal evidence',
      metadata: { phase: 'preflight' },
    });
    const persistedEvent = await client.query<{ raw_text: string | null; redacted_text: string }>(
      'SELECT raw_text, redacted_text FROM memory_events WHERE id = ?', [event.eventId],
    );
    expect(persistedEvent[0]!.raw_text).toBeNull();
    expect(persistedEvent[0]!.redacted_text).toContain('[REDACTED:BEARER]');
    expect(persistedEvent[0]!.redacted_text).not.toContain('super-secret-token-value');
    await expect(client.exec(`UPDATE memory_events SET redacted_text = 'mutated' WHERE id = '${event.eventId}'`)).rejects.toBeTruthy();

    const first = await store.commitMemory({
      scope: scopeA,
      canonicalKey: 'project.storage.policy',
      kind: 'guardrail',
      value: 'Keep artifacts in F:\\Projects\\Agent-Core',
      importance: 1,
      pinned: true,
      enforcement: 'hard',
      sourceType: 'primary_ai',
      sourceRef: 'commit-1',
    });
    expect(first.deduplicated).toBe(false);
    expect(first.revisionNo).toBe(1);

    const same = await store.commitMemory({
      scope: scopeA,
      canonicalKey: 'project.storage.policy',
      kind: 'guardrail',
      value: 'Keep artifacts in F:\\Projects\\Agent-Core',
      importance: 1,
      pinned: true,
      enforcement: 'hard',
      sourceType: 'primary_ai',
      sourceRef: 'commit-duplicate',
    });
    expect(same).toMatchObject({ memoryId: first.memoryId, revisionId: first.revisionId, revisionNo: 1, deduplicated: true });

    const revised = await store.reviseMemory({
      scope: scopeA,
      memoryId: first.memoryId,
      value: 'Keep all task artifacts and caches on drive F',
      sourceType: 'user_correction',
      sourceRef: 'revise-1',
    });
    expect(revised.memoryId).toBe(first.memoryId);
    expect(revised.revisionNo).toBe(2);
    expect(revised.supersededRevisionId).toBe(first.revisionId);

    const current = await store.getMemory(scopeA, first.memoryId);
    expect(current).toMatchObject({ memoryId: first.memoryId, revisionId: revised.revisionId, revisionNo: 2, valueText: 'Keep all task artifacts and caches on drive F', state: 'active' });
    expect(await store.getMemory(scopeB, first.memoryId)).toBeNull();
    expect((await store.listRevisions(scopeA, first.memoryId)).map((row) => row.revisionNo)).toEqual([1, 2]);
    expect(await store.listRevisions(scopeB, first.memoryId)).toEqual([]);
    await expect(store.reviseMemory({ scope: scopeB, memoryId: first.memoryId, value: 'cross principal' }))
      .rejects.toEqual(expect.objectContaining<Partial<MemoryStoreError>>({ code: 'MEMORY_NOT_FOUND' }));

    const beforeRollbackEvents = (await client.query<{ count: number }>("SELECT count(*) AS count FROM memory_events WHERE source_ref = 'rollback-fixture'"))[0]!.count;
    await expect(store.commitMemory({
      scope: scopeA,
      canonicalKey: 'rollback.fixture',
      kind: 'decision',
      value: 'must rollback',
      sourceType: 'test',
      sourceRef: 'rollback-fixture',
      explicitRelations: [{ targetMemoryId: 'missing-target', relation: 'explicit_relation' }],
    })).rejects.toBeTruthy();
    expect((await client.query<{ count: number }>("SELECT count(*) AS count FROM memory_events WHERE source_ref = 'rollback-fixture'"))[0]!.count).toBe(beforeRollbackEvents);
    expect((await client.query<{ count: number }>("SELECT count(*) AS count FROM memory_items WHERE canonical_key = 'rollback.fixture'"))[0]!.count).toBe(0);

    await expect(store.tombstoneMemory(scopeB, first.memoryId, 'not owner')).rejects.toMatchObject({ code: 'MEMORY_NOT_FOUND' });
    await store.tombstoneMemory(scopeA, first.memoryId, 'user requested forget');
    expect((await store.getMemory(scopeA, first.memoryId))!.state).toBe('tombstoned');
    expect(await client.query('SELECT memory_id FROM memory_fts WHERE memory_id = ?', [first.memoryId])).toEqual([]);

    const eventCount = (await client.query<{ count: number }>('SELECT count(*) AS count FROM memory_events'))[0]!.count;
    expect(eventCount).toBeGreaterThanOrEqual(5);
    await store.close();
  });
});
