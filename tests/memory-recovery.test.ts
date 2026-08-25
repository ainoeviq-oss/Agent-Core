import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { restoreMemoryDatabase } from '../src/memory/backup.js';
import { MemoryService } from '../src/memory/service.js';

const roots: string[] = [];
const services: MemoryService[] = [];
const children: ChildProcess[] = [];

async function exists(target: string): Promise<boolean> {
  try { await access(target); return true; } catch { return false; }
}

async function fileSize(target: string): Promise<number> {
  try { return (await stat(target)).size; } catch { return 0; }
}

async function fixture() {
  const root = await mkdtemp(path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), 'agent-core-memory-recovery-'));
  roots.push(root);
  const base = loadConfig({}, root).memory;
  const dbPath = path.join(root, 'runtime', 'memory', 'recovery.sqlite');
  const config = { ...base, enabled: true, dbPath, busyTimeoutMs: 1000 };
  const scope = { principalId: 'principal-recovery', projectId: root };
  const service = new MemoryService(config);
  services.push(service);
  return { root, dbPath, config, scope, service };
}

async function waitForLine(child: ChildProcess, expected: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stdout = '';
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${expected}: ${stdout}`)), 5000);
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.includes(expected)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      if (!stdout.includes(expected)) {
        clearTimeout(timeout);
        reject(new Error(`Child exited ${code} before ${expected}: ${stdout}`));
      }
    });
  });
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
  }
  await Promise.all(services.splice(0).map(async (service) => {
    try { await service.close(); } catch {}
  }));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('memory persistence, backup, restore, and crash recovery', () => {
  it('creates a consistent timestamped backup, reports integrity metadata, checkpoints WAL, and restores atomically only while stopped', async () => {
    const f = await fixture();
    const original = await f.service.commit({
      scope: f.scope,
      canonicalKey: 'recovery.policy',
      kind: 'guardrail',
      value: 'Keep recovery artifacts on drive F.',
      importance: 1,
      pinned: true,
      enforcement: 'hard',
      sourceType: 'test',
      sourceRef: 'task14-original',
    });

    const initialStatus = await f.service.status(f.scope);
    expect(initialStatus.healthy).toBe(true);
    expect(initialStatus.integrity).toBe('ok');
    expect(initialStatus.lastIntegrityCheckAt).toEqual(expect.any(Number));
    expect(initialStatus.lastSuccessfulIntegrityCheckAt).toEqual(expect.any(Number));
    expect(initialStatus.counts.db_bytes).toBeGreaterThan(0);

    const backup = await f.service.backup('pre-destructive-test');
    expect(backup.backupPath).toContain(path.join('runtime', 'memory', 'backups'));
    expect(await exists(backup.backupPath)).toBe(true);
    expect(await fileSize(backup.backupPath)).toBeGreaterThan(0);
    const afterBackupStatus = await f.service.status(f.scope);
    expect(afterBackupStatus.lastBackupPath).toBe(backup.backupPath);
    expect(afterBackupStatus.lastBackupAt).toBe(backup.createdAt);

    await f.service.revise({
      scope: f.scope,
      memoryId: original.memoryId,
      value: 'Changed after backup and must disappear after restore.',
      sourceType: 'test',
      sourceRef: 'task14-after-backup',
    });
    await f.service.close();
    services.splice(services.indexOf(f.service), 1);

    expect(await fileSize(`${f.dbPath}-wal`)).toBe(0);
    expect(await fileSize(`${f.dbPath}-shm`)).toBe(0);

    await expect(restoreMemoryDatabase({
      dbPath: f.dbPath,
      backupPath: backup.backupPath,
      serviceStopped: false,
      busyTimeoutMs: 1000,
    })).rejects.toThrow(/stopped/i);

    const restored = await restoreMemoryDatabase({
      dbPath: f.dbPath,
      backupPath: backup.backupPath,
      serviceStopped: true,
      busyTimeoutMs: 1000,
    });
    expect(restored.restored).toBe(true);
    expect(restored.preRestoreBackupPath).toBeTruthy();
    expect(await exists(restored.preRestoreBackupPath!)).toBe(true);

    const reopened = new MemoryService(f.config);
    services.push(reopened);
    const memory = await reopened.getMemory(f.scope, original.memoryId);
    expect(memory?.valueText).toContain('Keep recovery artifacts on drive F.');
    expect(memory?.valueText).not.toContain('Changed after backup');
    const status = await reopened.status(f.scope);
    expect(status.healthy).toBe(true);
    expect(status.integrity).toBe('ok');
    expect(status.lastBackupPath).toBeTruthy();
  });

  it('creates an automatic pre-migration backup when an existing database has an older user_version', async () => {
    const f = await fixture();
    const committed = await f.service.commit({
      scope: f.scope,
      canonicalKey: 'migration.proof',
      kind: 'fact',
      value: 'Persist before migration.',
      sourceType: 'test',
    });
    await f.service.close();
    services.splice(services.indexOf(f.service), 1);

    const db = new DatabaseSync(f.dbPath);
    db.exec('PRAGMA user_version = 0');
    db.close();

    const reopened = new MemoryService(f.config);
    services.push(reopened);
    const status = await reopened.status(f.scope);
    expect(status.healthy).toBe(true);
    expect(status.schemaVersion).toBe(1);
    expect(status.lastBackupPath).toContain('pre-migration-v0-to-v1');
    expect(await exists(status.lastBackupPath!)).toBe(true);
    expect((await reopened.getMemory(f.scope, committed.memoryId))?.valueText).toContain('Persist before migration.');
  });

  it('recovers committed memory after a writer process is terminated with an uncommitted WAL transaction', async () => {
    const f = await fixture();
    const committed = await f.service.commit({
      scope: f.scope,
      canonicalKey: 'crash.baseline',
      kind: 'fact',
      value: 'Committed before crash.',
      sourceType: 'test',
    });
    await f.service.close();
    services.splice(services.indexOf(f.service), 1);

    const script = `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(${JSON.stringify(f.dbPath)});
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('BEGIN IMMEDIATE');
      db.prepare(\`INSERT INTO memory_events(id, principal_id, project_id, thread_id, resource_id, event_type, source_type, source_ref, raw_text, redacted_text, metadata_json, created_at) VALUES (?, ?, ?, NULL, NULL, ?, ?, NULL, NULL, ?, '{}', ?)\`)
        .run('crash-uncommitted-event', 'principal-recovery', ${JSON.stringify(f.root)}, 'crash.test', 'test', 'must rollback', Date.now());
      process.stdout.write('WRITE_OPEN\\n');
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    await waitForLine(child, 'WRITE_OPEN');
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    children.splice(children.indexOf(child), 1);

    const reopened = new MemoryService(f.config);
    services.push(reopened);
    const status = await reopened.status(f.scope);
    expect(status.healthy).toBe(true);
    expect(status.integrity).toBe('ok');
    expect((await reopened.getMemory(f.scope, committed.memoryId))?.valueText).toContain('Committed before crash.');
    const exported = await reopened.export(f.scope, 100);
    expect(exported.events.some((event) => event.eventId === 'crash-uncommitted-event')).toBe(false);
  });

  it('fails memory closed with degraded integrity status for a corrupt database file', async () => {
    const f = await fixture();
    await f.service.close();
    services.splice(services.indexOf(f.service), 1);
    await rm(path.dirname(f.dbPath), { recursive: true, force: true });
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(path.dirname(f.dbPath), { recursive: true });
    await writeFile(f.dbPath, 'not-a-sqlite-database', 'utf8');

    const corrupt = new MemoryService(f.config);
    services.push(corrupt);
    const status = await corrupt.status(f.scope);
    expect(status.enabled).toBe(true);
    expect(status.healthy).toBe(false);
    expect(status.integrity).toMatch(/^degraded:/);
    await expect(corrupt.search({ scope: f.scope, query: 'anything' })).rejects.toThrow(/degraded|sqlite|database/i);
  });
});
