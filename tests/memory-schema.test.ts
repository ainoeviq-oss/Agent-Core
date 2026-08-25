import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  MEMORY_ENFORCEMENTS,
  MEMORY_KINDS,
  MEMORY_RELATIONS,
  MEMORY_STATES,
} from '../src/memory/types.js';
import { MEMORY_SCHEMA_VERSION, initializeMemorySchema, rebuildMemoryFts } from '../src/memory/schema.js';

describe('deterministic memory schema and public contracts', () => {
  it('exposes exact minimum kinds, states, relations, enforcement and deterministic defaults', () => {
    expect(MEMORY_KINDS).toEqual([
      'fact', 'preference', 'guardrail', 'decision', 'goal', 'task', 'artifact',
      'procedure', 'tool_state', 'project_state', 'failure', 'observation', 'relationship',
    ]);
    expect(MEMORY_STATES).toEqual(['active', 'superseded', 'completed', 'archived', 'tombstoned', 'conflicted']);
    expect(MEMORY_RELATIONS).toEqual([
      'same_key', 'supersedes', 'explicit_relation', 'same_anchor', 'same_artifact',
      'same_route_or_task', 'cooccurs_in_event', 'token_overlap', 'temporal_neighbor',
    ]);
    expect(MEMORY_ENFORCEMENTS).toEqual(['none', 'soft', 'hard']);

    const baseDir = path.resolve('F:\\Projects\\Agent-Core');
    const config = loadConfig({}, baseDir);
    expect(config.memory.enabled).toBe(false);
    expect(config.memory.dbPath).toBe(path.join(baseDir, 'runtime', 'memory', 'agent-core-memory.sqlite'));
    expect(config.memory.graphNodeCap).toBe(1000);
    expect(config.memory.graphEdgeCap).toBe(10_000);
    expect(config.memory.pprDamping).toBe(0.85);
    expect(config.memory.pprEpsilon).toBe(1e-6);
    expect(config.memory.pprMaxIterations).toBe(20);
    expect(config.memory.scoreWeights).toEqual({ lexical: 0.40, exact: 0.20, graph: 0.20, state: 0.08, importance: 0.07, recency: 0.05 });
  });

  it('migrates idempotently, enforces foreign keys, records schema version, and rebuilds FTS deterministically', () => {
    const db = new DatabaseSync(':memory:');
    try {
      initializeMemorySchema(db);
      initializeMemorySchema(db);

      expect(Number(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys)).toBe(1);
      expect(Number(db.prepare('PRAGMA user_version').get()!.user_version)).toBe(MEMORY_SCHEMA_VERSION);
      expect(db.prepare('SELECT name FROM memory_schema_migrations ORDER BY version').all()).toEqual([
        { name: '001_initial_memory' },
      ]);

      const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as Array<{ name: string }>).map((row) => row.name));
      for (const name of ['memory_events', 'memory_items', 'memory_revisions', 'memory_anchors', 'memory_edges', 'memory_conflicts', 'memory_contexts', 'memory_access_log', 'memory_fts']) {
        expect(tables.has(name)).toBe(true);
      }

      expect(() => db.prepare(`INSERT INTO memory_revisions(
        id, memory_id, revision_no, value_text, value_hash, valid_from, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run('rev-orphan', 'missing-memory', 1, 'orphan', 'hash', 1, 1)).toThrow();

      db.prepare(`INSERT INTO memory_events(
        id, principal_id, event_type, source_type, redacted_text, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run('event-1', 'principal-1', 'memory.committed', 'test', 'Use project-local deterministic memory', '{}', 1);
      db.prepare(`INSERT INTO memory_items(
        id, principal_id, canonical_key, kind, state, importance, pinned, enforcement,
        created_at, updated_at, last_accessed_at, access_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('memory-1', 'principal-1', 'project.storage.policy', 'guardrail', 'active', 1, 1, 'hard', 1, 1, 1, 0);
      db.prepare(`INSERT INTO memory_revisions(
        id, memory_id, revision_no, value_text, value_hash, source_event_id, valid_from, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('rev-1', 'memory-1', 1, 'Keep all project artifacts on drive F', 'hash-1', 'event-1', 1, 1);
      db.prepare('UPDATE memory_items SET current_revision_id = ? WHERE id = ?').run('rev-1', 'memory-1');
      db.prepare('INSERT INTO memory_anchors(memory_id, anchor, anchor_type, created_at) VALUES (?, ?, ?, ?)')
        .run('memory-1', 'F:\\Projects', 'path', 1);

      rebuildMemoryFts(db);
      const first = db.prepare(`SELECT memory_id, canonical_key, anchors, value_text
        FROM memory_fts WHERE memory_fts MATCH ? ORDER BY memory_id`).all('artifacts');
      rebuildMemoryFts(db);
      const second = db.prepare(`SELECT memory_id, canonical_key, anchors, value_text
        FROM memory_fts WHERE memory_fts MATCH ? ORDER BY memory_id`).all('artifacts');
      expect(second).toEqual(first);
      expect(second).toHaveLength(1);
      expect(second[0]).toMatchObject({ memory_id: 'memory-1', canonical_key: 'project.storage.policy' });
    } finally {
      db.close();
    }
  });
});
