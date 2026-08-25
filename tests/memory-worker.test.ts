import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryWorkerClient, MemoryWorkerError } from '../src/memory/worker-client.js';

function tempRoot(label: string): string {
  const base = process.env.TEMP || process.env.TMP || os.tmpdir();
  return mkdtempSync(path.join(base, `agent-core-dmf-${label}-`));
}

describe('memory sqlite worker', () => {
  it('owns sqlite in a worker, configures pragmas, serializes concurrent work, transactions, integrity, restart and close', async () => {
    const root = tempRoot('worker');
    const dbPath = path.join(root, 'memory.sqlite');
    const client = new MemoryWorkerClient();

    await client.open({ dbPath, busyTimeoutMs: 1234 });
    const pragmas = await client.query<{
      journal_mode: string;
      foreign_keys: number;
      synchronous: number;
      busy_timeout: number;
    }>(`SELECT
      (SELECT journal_mode FROM pragma_journal_mode) AS journal_mode,
      (SELECT foreign_keys FROM pragma_foreign_keys) AS foreign_keys,
      (SELECT synchronous FROM pragma_synchronous) AS synchronous,
      (SELECT timeout FROM pragma_busy_timeout) AS busy_timeout`);
    expect(pragmas[0]).toMatchObject({ journal_mode: 'wal', foreign_keys: 1, synchronous: 1, busy_timeout: 1234 });

    await client.exec('CREATE TABLE ordered(id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      client.transaction([
        { kind: 'run', sql: 'INSERT INTO ordered(id, value) VALUES (?, ?)', params: [index + 1, `v${index + 1}`] },
      ])));

    const tx = await client.transaction([
      { kind: 'run', sql: 'INSERT INTO ordered(id, value) VALUES (?, ?)', params: [21, 'first'] },
      { kind: 'run', sql: 'INSERT INTO ordered(id, value) VALUES (?, ?)', params: [22, 'second'] },
      { kind: 'query', sql: 'SELECT id, value FROM ordered WHERE id >= ? ORDER BY id', params: [21], mode: 'all' },
    ]);
    expect(tx[2]).toEqual([{ id: 21, value: 'first' }, { id: 22, value: 'second' }]);
    expect(await client.query<{ count: number }>('SELECT count(*) AS count FROM ordered')).toEqual([{ count: 22 }]);
    expect(await client.integrity()).toEqual({ ok: true, result: 'ok' });

    await client.close();
    await client.close();

    const restarted = new MemoryWorkerClient();
    await restarted.open({ dbPath, busyTimeoutMs: 1234 });
    expect(await restarted.query<{ count: number }>('SELECT count(*) AS count FROM ordered')).toEqual([{ count: 22 }]);
    await restarted.close();
  });

  it('returns stable error codes for invalid/corrupt paths and bounded result overflow', async () => {
    const root = tempRoot('errors');

    const directoryPath = path.join(root, 'directory.sqlite');
    mkdirSync(directoryPath);
    const invalid = new MemoryWorkerClient();
    await expect(invalid.open({ dbPath: directoryPath })).rejects.toMatchObject({ code: 'MEMORY_DB_OPEN_FAILED' });
    await invalid.close();

    const corruptPath = path.join(root, 'corrupt.sqlite');
    writeFileSync(corruptPath, 'not a sqlite database', 'utf8');
    const corrupt = new MemoryWorkerClient();
    await expect(corrupt.open({ dbPath: corruptPath })).rejects.toMatchObject({ code: 'MEMORY_DB_OPEN_FAILED' });
    await corrupt.close();

    const bounded = new MemoryWorkerClient({ maxResponseBytes: 128 });
    await bounded.open({ dbPath: ':memory:' });
    await expect(bounded.query("SELECT printf('%0500d', 1) AS huge"))
      .rejects.toEqual(expect.objectContaining<Partial<MemoryWorkerError>>({ code: 'MEMORY_RESULT_TOO_LARGE' }));
    await bounded.close();
  });
});
