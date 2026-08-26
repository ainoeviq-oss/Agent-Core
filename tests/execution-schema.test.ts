import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { EXECUTION_SCHEMA_SQL, EXECUTION_SCHEMA_VERSION } from '../src/execution/schema.js';
import { ExecutionStore } from '../src/execution/store.js';

const roots: string[] = [];
const stores: ExecutionStore[] = [];
const children: ChildProcess[] = [];

async function fixture(label: string) {
  const root = await mkdtemp(path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), `agent-core-execution-schema-${label}-`));
  roots.push(root);
  return { root, dbPath: path.join(root, 'runtime', 'execution', 'execution.sqlite') };
}

async function waitForLine(child: ChildProcess, expected: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${expected}: ${stdout}`)), 5_000);
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.includes(expected)) { clearTimeout(timer); resolve(); }
    });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => {
      if (!stdout.includes(expected)) {
        clearTimeout(timer);
        reject(new Error(`Child exited ${code} before ${expected}: ${stdout}`));
      }
    });
  });
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
  }
  await Promise.all(stores.splice(0).map(async (store) => {
    try { await store.close(); } catch {}
  }));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('execution fabric SQLite schema and worker lifecycle', () => {
  it('opens schema v2 with all execution tables, foreign keys, WAL, integrity, evidence column, and idempotent reopen', async () => {
    const f = await fixture('open');
    const store = new ExecutionStore();
    stores.push(store);
    const opened = await store.open({ dbPath: f.dbPath, busyTimeoutMs: 1_500 }) as any;
    expect(opened).toMatchObject({ priorUserVersion: 0, schemaVersion: 2, quickCheck: 'ok', integrity: 'ok' });
    expect(EXECUTION_SCHEMA_VERSION).toBe(2);
    const status = await store.status();
    expect(status).toMatchObject({ healthy: true, schemaVersion: 2, integrity: 'ok', dbPath: f.dbPath });
    expect(Number((await store.client.query<{ foreign_keys: number }>('PRAGMA foreign_keys'))[0]?.foreign_keys)).toBe(1);
    expect(String((await store.client.query<{ journal_mode: string }>('PRAGMA journal_mode'))[0]?.journal_mode).toLowerCase()).toBe('wal');
    expect(Number((await store.client.query<{ wal_autocheckpoint: number }>('PRAGMA wal_autocheckpoint'))[0]?.wal_autocheckpoint)).toBe(0);
    await store.close();
    stores.splice(stores.indexOf(store), 1);

    const db = new DatabaseSync(f.dbPath);
    try {
      expect(Number(db.prepare('PRAGMA user_version').get()!.user_version)).toBe(2);
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'execution_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
      expect(tables).toEqual([
        'execution_attempts',
        'execution_dependencies',
        'execution_events',
        'execution_memory_sync_queue',
        'execution_nodes',
        'execution_runs',
        'execution_schema_migrations',
      ]);
      expect(db.prepare('SELECT version, name FROM execution_schema_migrations ORDER BY version').all()).toEqual([
        { version: 1, name: '001_initial_execution_fabric' },
        { version: 2, name: '002_declared_artifact_evidence' },
      ]);
      const nodeColumns = (db.prepare('PRAGMA table_info(execution_nodes)').all() as Array<{ name: string }>).map((row) => row.name);
      expect(nodeColumns).toContain('expected_artifacts_json');
      expect(String(db.prepare('PRAGMA quick_check').get()!.quick_check)).toBe('ok');
    } finally {
      db.close();
    }

    const reopened = new ExecutionStore();
    stores.push(reopened);
    const reopenedStatus = await reopened.open({ dbPath: f.dbPath, busyTimeoutMs: 1_500 }) as any;
    expect(reopenedStatus).toMatchObject({ priorUserVersion: 2, schemaVersion: 2, quickCheck: 'ok', integrity: 'ok' });
  });

  it('backs up and migrates an existing schema v1 database to v2 without losing existing runs or nodes', async () => {
    const f = await fixture('migrate-v1');
    await mkdir(path.dirname(f.dbPath), { recursive: true });
    const v1Sql = EXECUTION_SCHEMA_SQL.replace("  expected_artifacts_json TEXT NOT NULL DEFAULT '[]',\n", '');
    const now = Date.now();
    const db = new DatabaseSync(f.dbPath);
    try {
      db.exec(v1Sql);
      db.prepare('INSERT INTO execution_schema_migrations(version, name, applied_at) VALUES (1, ?, ?)')
        .run('001_initial_execution_fabric', now);
      db.exec('PRAGMA user_version = 1');
      db.prepare(`INSERT INTO execution_runs(
        id, principal_id, project_id, continuity_task_id, origin_route_context_id,
        state, objective, max_concurrency, last_event_sequence, metadata_json,
        created_at, started_at, finished_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'planned', ?, 1, 0, '{}', ?, NULL, NULL, ?)`)
        .run('legacy-run', 'principal-v1', 'project-v1', 'task-v1', 'route-v1', 'Legacy run survives migration', now, now);
      db.prepare(`INSERT INTO execution_nodes(
        run_id,node_id,purpose,command_text,cwd,state,timeout_ms,continue_on_failure,
        attempt_count,last_error_json,created_at,updated_at,started_at,finished_at
      ) VALUES (?,?,'legacy node','echo legacy',?,'queued',30000,0,0,NULL,?,?,NULL,NULL)`)
        .run('legacy-run', 'A', f.root, now, now);
    } finally {
      db.close();
    }

    const store = new ExecutionStore();
    stores.push(store);
    const opened = await store.open({ dbPath: f.dbPath, busyTimeoutMs: 1_500 });
    expect(opened).toMatchObject({ priorUserVersion: 1, schemaVersion: 2, integrity: 'ok' });
    expect(opened.migrationBackupPath).toBeTruthy();
    await expect(access(opened.migrationBackupPath!)).resolves.toBeUndefined();
    expect((await store.getRun({ principalId: 'principal-v1', projectId: 'project-v1' }, 'legacy-run'))?.objective)
      .toBe('Legacy run survives migration');
    expect(await store.getNodes({ principalId: 'principal-v1', projectId: 'project-v1' }, 'legacy-run'))
      .toEqual([expect.objectContaining({ nodeId: 'A', expectedArtifacts: [] })]);

    const backup = new DatabaseSync(opened.migrationBackupPath!, { readOnly: true });
    try {
      expect(Number(backup.prepare('PRAGMA user_version').get()!.user_version)).toBe(1);
      const columns = (backup.prepare('PRAGMA table_info(execution_nodes)').all() as Array<{ name: string }>).map((row) => row.name);
      expect(columns).not.toContain('expected_artifacts_json');
      expect(String(backup.prepare('PRAGMA quick_check').get()!.quick_check)).toBe('ok');
    } finally {
      backup.close();
    }
  });

  it('recovers committed runs after an uncommitted WAL writer is terminated and never invents the uncommitted run', async () => {
    const f = await fixture('crash');
    const store = new ExecutionStore();
    stores.push(store);
    await store.open({ dbPath: f.dbPath, busyTimeoutMs: 1_000 });
    const baseline = await store.createRun(
      { principalId: 'principal-crash', projectId: 'project-crash' },
      { objective: 'Committed run survives crash', continuityTaskId: 'task-crash', originRouteContextId: 'route-crash', maxConcurrency: 2 },
    );
    await store.close();
    stores.splice(stores.indexOf(store), 1);

    const script = `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(${JSON.stringify(f.dbPath)});
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('BEGIN IMMEDIATE');
      db.prepare(\`INSERT INTO execution_runs(
        id, principal_id, project_id, continuity_task_id, origin_route_context_id,
        state, objective, max_concurrency, last_event_sequence, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, NULL, 'planned', ?, 1, 0, '{}', ?, ?)\`)
        .run('crash-uncommitted-run', 'principal-crash', 'project-crash', 'must roll back', Date.now(), Date.now());
      process.stdout.write('WRITE_OPEN\\n');
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    await waitForLine(child, 'WRITE_OPEN');
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    children.splice(children.indexOf(child), 1);

    const reopened = new ExecutionStore();
    stores.push(reopened);
    await reopened.open({ dbPath: f.dbPath, busyTimeoutMs: 1_000 });
    expect((await reopened.getRun({ principalId: 'principal-crash', projectId: 'project-crash' }, baseline.runId))?.runId).toBe(baseline.runId);
    expect(await reopened.getRun({ principalId: 'principal-crash', projectId: 'project-crash' }, 'crash-uncommitted-run')).toBeNull();
    expect((await reopened.status()).integrity).toBe('ok');
  });
});
