import { randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { MemoryWorkerClient } from './worker-client.js';

export interface MemoryBackupRecord {
  backupPath: string;
  createdAt: number;
  reason: string;
}

export interface RestoreMemoryDatabaseOptions {
  dbPath: string;
  backupPath: string;
  serviceStopped: boolean;
  busyTimeoutMs?: number;
}

export interface RestoreMemoryDatabaseResult {
  restored: true;
  dbPath: string;
  sourceBackupPath: string;
  preRestoreBackupPath?: string;
}

function backupDirectory(dbPath: string): string {
  return path.join(path.dirname(path.resolve(dbPath)), 'backups');
}

function manifestPath(dbPath: string): string {
  return path.join(backupDirectory(dbPath), 'last-backup.json');
}

function safeReason(reason: string): string {
  const normalized = reason.trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return normalized || 'backup';
}

function timestamp(value: number): string {
  return new Date(value).toISOString().replace(/[:.]/g, '-');
}

export function createMemoryBackupPath(dbPath: string, reason: string, createdAt = Date.now()): string {
  const ext = path.extname(dbPath) || '.sqlite';
  const base = path.basename(dbPath, path.extname(dbPath));
  return path.join(
    backupDirectory(dbPath),
    `${base}.${timestamp(createdAt)}.${safeReason(reason)}${ext}`,
  );
}

async function fileExists(target: string): Promise<boolean> {
  try {
    const info = await stat(target);
    return info.isFile();
  } catch {
    return false;
  }
}

async function removeSidecars(dbPath: string): Promise<void> {
  await Promise.all([
    rm(`${dbPath}-wal`, { force: true }).catch(() => undefined),
    rm(`${dbPath}-shm`, { force: true }).catch(() => undefined),
  ]);
}

async function preserveDatabaseMode(dbPath: string, backupPath: string): Promise<void> {
  try {
    const info = await stat(dbPath);
    await chmod(backupPath, info.mode & 0o777);
  } catch {
    // Windows/runtime ACL policy is inherited from the containing runtime directory.
  }
}

async function writeBackupManifest(dbPath: string, record: MemoryBackupRecord): Promise<void> {
  const target = manifestPath(dbPath);
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  await rm(target, { force: true }).catch(() => undefined);
  await rename(temp, target);
}

export async function readLatestMemoryBackup(dbPath: string): Promise<MemoryBackupRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(manifestPath(dbPath), 'utf8')) as Partial<MemoryBackupRecord>;
    if (
      typeof parsed.backupPath !== 'string'
      || typeof parsed.createdAt !== 'number'
      || typeof parsed.reason !== 'string'
    ) return null;
    return {
      backupPath: parsed.backupPath,
      createdAt: parsed.createdAt,
      reason: parsed.reason,
    };
  } catch {
    return null;
  }
}

export async function createMemoryBackup(
  client: MemoryWorkerClient,
  dbPath: string,
  reason: string,
  createdAt = Date.now(),
): Promise<MemoryBackupRecord> {
  if (!reason.trim()) throw new Error('MEMORY_BACKUP_REASON_REQUIRED');
  const backupPath = createMemoryBackupPath(dbPath, reason, createdAt);
  await mkdir(path.dirname(backupPath), { recursive: true });
  await client.backup(backupPath);
  await preserveDatabaseMode(dbPath, backupPath);
  const record = { backupPath, createdAt, reason } satisfies MemoryBackupRecord;
  await writeBackupManifest(dbPath, record);
  return record;
}

async function validateDatabaseFile(dbPath: string, busyTimeoutMs: number): Promise<void> {
  const client = new MemoryWorkerClient();
  try {
    await client.open({ dbPath, busyTimeoutMs });
    const integrity = await client.integrity();
    if (!integrity.ok) throw new Error(`MEMORY_RESTORE_INTEGRITY_FAILED:${integrity.result}`);
    await client.checkpoint();
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function backupExistingStoppedDatabase(
  dbPath: string,
  busyTimeoutMs: number,
): Promise<MemoryBackupRecord | undefined> {
  if (!await fileExists(dbPath)) return undefined;
  const client = new MemoryWorkerClient();
  try {
    await client.open({ dbPath, busyTimeoutMs });
    const integrity = await client.integrity();
    if (!integrity.ok) throw new Error(`MEMORY_PRE_RESTORE_INTEGRITY_FAILED:${integrity.result}`);
    return await createMemoryBackup(client, dbPath, 'pre-restore');
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function restoreMemoryDatabase(
  options: RestoreMemoryDatabaseOptions,
): Promise<RestoreMemoryDatabaseResult> {
  if (!options.serviceStopped) {
    throw new Error('MEMORY_RESTORE_REQUIRES_STOPPED_SERVICE');
  }
  const dbPath = path.resolve(options.dbPath);
  const backupPath = path.resolve(options.backupPath);
  const busyTimeoutMs = options.busyTimeoutMs ?? 5000;
  if (!await fileExists(backupPath)) throw new Error('MEMORY_BACKUP_NOT_FOUND');

  await validateDatabaseFile(backupPath, busyTimeoutMs);
  const preRestore = await backupExistingStoppedDatabase(dbPath, busyTimeoutMs);
  await removeSidecars(dbPath);

  await mkdir(path.dirname(dbPath), { recursive: true });
  const token = randomUUID();
  const stagingPath = path.join(path.dirname(dbPath), `.${path.basename(dbPath)}.restore-${token}.tmp`);
  const rollbackPath = path.join(path.dirname(dbPath), `.${path.basename(dbPath)}.rollback-${token}.tmp`);
  const hadDatabase = await fileExists(dbPath);

  await copyFile(backupPath, stagingPath);
  await preserveDatabaseMode(backupPath, stagingPath);
  await validateDatabaseFile(stagingPath, busyTimeoutMs);
  await removeSidecars(stagingPath);

  if (hadDatabase) await rename(dbPath, rollbackPath);
  try {
    await rename(stagingPath, dbPath);
    await validateDatabaseFile(dbPath, busyTimeoutMs);
    await removeSidecars(dbPath);
    if (hadDatabase) await rm(rollbackPath, { force: true });
  } catch (error) {
    await rm(stagingPath, { force: true }).catch(() => undefined);
    await removeSidecars(stagingPath);
    await rm(dbPath, { force: true }).catch(() => undefined);
    await removeSidecars(dbPath);
    if (hadDatabase && await fileExists(rollbackPath)) {
      await rename(rollbackPath, dbPath);
    }
    throw error;
  } finally {
    await rm(stagingPath, { force: true }).catch(() => undefined);
    await removeSidecars(stagingPath);
  }

  return {
    restored: true,
    dbPath,
    sourceBackupPath: backupPath,
    ...(preRestore ? { preRestoreBackupPath: preRestore.backupPath } : {}),
  };
}
