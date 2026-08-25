import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { MemoryService } from '../src/memory/service.js';
import { MEMORY_SCHEMA_VERSION, initializeMemorySchema } from '../src/memory/schema.js';
import { MemoryStore } from '../src/memory/store.js';

const roots: string[] = [];
const services: MemoryService[] = [];

const CONTINUITY_TABLES = [
  'continuity_turns',
  'continuity_tasks',
  'continuity_task_dependencies',
  'continuity_checkpoints',
  'continuity_frontier',
] as const;

function tableNames(db: DatabaseSync): Set<string> {
  return new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
    .map((row) => row.name));
}

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}

function downgradeToV1(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      DROP TABLE IF EXISTS continuity_turns;
      DROP TABLE IF EXISTS continuity_task_dependencies;
      DROP TABLE IF EXISTS continuity_checkpoints;
      DROP TABLE IF EXISTS continuity_frontier;
      DROP TABLE IF EXISTS continuity_tasks;
      DELETE FROM memory_schema_migrations WHERE version >= 2;
      PRAGMA user_version = 1;
    `);
  } finally {
    db.close();
  }
}

async function fileFixture(label: string) {
  const root = await mkdtemp(path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), `agent-core-continuity-schema-${label}-`));
  roots.push(root);
  const base = loadConfig({}, root).memory;
  const dbPath = path.join(root, 'runtime', 'memory', 'continuity.sqlite');
  const config = { ...base, enabled: true, dbPath, busyTimeoutMs: 1000 };
  const scope = { principalId: 'principal-continuity-schema', projectId: root };
  const service = new MemoryService(config);
  services.push(service);
  return { root, dbPath, config, scope, service };
}

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => {
    try { await service.close(); } catch {}
  }));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('DMF schema v2 continuity ledger', () => {
  it('creates schema v2 idempotently with the complete continuity ledger and both migration records', () => {
    const db = new DatabaseSync(':memory:');
    try {
      initializeMemorySchema(db);
      initializeMemorySchema(db);

      expect(MEMORY_SCHEMA_VERSION).toBe(2);
      expect(Number(db.prepare('PRAGMA user_version').get()!.user_version)).toBe(2);
      expect(db.prepare('SELECT version, name FROM memory_schema_migrations ORDER BY version').all()).toEqual([
        { version: 1, name: '001_initial_memory' },
        { version: 2, name: '002_continuity_ledger' },
      ]);

      const tables = tableNames(db);
      for (const table of CONTINUITY_TABLES) expect(tables.has(table)).toBe(true);

      expect(columns(db, 'continuity_turns')).toEqual(expect.arrayContaining([
        'id', 'principal_id', 'project_id', 'route_context_id', 'task_id',
        'input_text', 'input_hash', 'context_text', 'state', 'created_at', 'closed_at',
      ]));
      expect(columns(db, 'continuity_tasks')).toEqual(expect.arrayContaining([
        'id', 'principal_id', 'project_id', 'parent_task_id', 'title', 'objective',
        'acceptance_json', 'constraints_json', 'status', 'priority', 'blocker_json',
        'last_checkpoint_id', 'created_at', 'updated_at', 'completed_at',
      ]));
      expect(columns(db, 'continuity_task_dependencies')).toEqual(expect.arrayContaining([
        'task_id', 'depends_on_task_id', 'dependency_type', 'created_at',
      ]));
      expect(columns(db, 'continuity_checkpoints')).toEqual(expect.arrayContaining([
        'id', 'principal_id', 'project_id', 'task_id', 'route_context_id',
        'phase', 'summary_json', 'evidence_json', 'state_hash', 'created_at',
      ]));
      expect(columns(db, 'continuity_frontier')).toEqual(expect.arrayContaining([
        'id', 'principal_id', 'project_id', 'source_task_id', 'title', 'rationale',
        'status', 'dependency_task_ids_json', 'priority', 'created_at', 'updated_at',
      ]));

      expect(String(db.prepare('PRAGMA quick_check').get()!.quick_check)).toBe('ok');
    } finally {
      db.close();
    }
  });

  it('rolls a failed v1-to-v2 migration back, preserves v1 memory, and leaves a verified pre-migration backup', async () => {
    const f = await fileFixture('rollback');
    const committed = await f.service.commit({
      scope: f.scope,
      canonicalKey: 'continuity.schema.rollback.proof',
      kind: 'fact',
      value: 'Must survive a failed continuity migration.',
      sourceType: 'test',
    });
    await f.service.close();
    services.splice(services.indexOf(f.service), 1);
    downgradeToV1(f.dbPath);

    const sabotage = new DatabaseSync(f.dbPath);
    try {
      sabotage.exec('CREATE TABLE continuity_tasks(id TEXT PRIMARY KEY)');
    } finally {
      sabotage.close();
    }

    const store = new MemoryStore();
    try {
      await expect(store.open({ dbPath: f.dbPath, busyTimeoutMs: 1000 })).rejects.toBeTruthy();
    } finally {
      await store.close();
    }

    const verify = new DatabaseSync(f.dbPath);
    try {
      expect(Number(verify.prepare('PRAGMA user_version').get()!.user_version)).toBe(1);
      expect(Number(verify.prepare('SELECT count(*) AS count FROM memory_schema_migrations WHERE version = 2').get()!.count)).toBe(0);
      expect(tableNames(verify).has('continuity_turns')).toBe(false);
      expect(Number(verify.prepare('SELECT count(*) AS count FROM memory_items WHERE id = ?').get(committed.memoryId)!.count)).toBe(1);
      expect(String(verify.prepare('PRAGMA integrity_check').get()!.integrity_check)).toBe('ok');
    } finally {
      verify.close();
    }

    const backupDir = path.join(path.dirname(f.dbPath), 'backups');
    const backups = await readdir(backupDir);
    expect(backups.some((name) => name.includes('pre-migration-v1-to-v2') && name.endsWith('.sqlite'))).toBe(true);
  });
});
