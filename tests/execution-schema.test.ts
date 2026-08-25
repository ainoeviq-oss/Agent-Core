import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { EXECUTION_SCHEMA_VERSION } from '../src/execution/schema.js';
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
  it('opens schema v1 with all execution tables, foreign keys, WAL, integrity, and idempotent reopen', async () => {
    const f = await fixture('open');
    const store = new ExecutionStore();
    stores.push(store);
    const opened = await store.open({ dbPath: f.dbPath, busyTimeoutMs: 1_500 }) as any;
    expect(opened).toMatchObject({ schemaVersion: 1, quickCheck: 'ok', integrity: 'ok' });
    expect(EXECUTION_SCHEMA_VERSION).toBe(1);
    const status = await store.status();
    expect(status).toMatchObject({ healthy: true, schemaVersion: 1, integrity: 'ok', dbPath: f.dbPath });
    expect(Number((await store.client.query<{ foreign_keys: number }>('PRAGMA foreign_keys'))[0]?.foreign_keys)).toBe(1);
    expect(String((await store.client.query<{ journal_mode: string }>('PRAGMA journal_mode'))[0]?.journal_mode).toLowerCase()).toBe('wal');
    expect(Number((await store.client.query<{ wal_autocheckpoint: number }>('PRAGMA wal_autocheckpoint'))[0]?.wal_autocheckpoint)).toBe(4096);
    await store.close();
    stores.splice(stores.indexOf(store), 1);

    const db = new DatabaseSync(f.dbPath);
    try {
      expect(Number(db.prepare('PRAGMA user_version').get()!.user_version)).toBe(1);
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
      ]);
      expect(String(db.prepare('PRAGMA quick_check').get()!.quick_check)).toBe('ok');
    } finally {
      db.close();
    }

    const reopened = new ExecutionStore();
    stores.push(reopened);
    const reopenedStatus = await reopened.open({ dbPath: f.dbPath, busyTimeoutMs: 1_500 }) as any;
    expect(reopenedStatus).toMatchObject({ schemaVersion: 1, quickCheck: 'ok', integrity: 'ok' });
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
