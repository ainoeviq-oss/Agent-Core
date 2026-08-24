import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

function versionAtLeast(actual: string, minimum: [number, number, number]): boolean {
  const [major = 0, minor = 0, patch = 0] = actual.replace(/^v/, '').split('.').map(Number);
  const [minMajor, minMinor, minPatch] = minimum;
  if (major !== minMajor) return major > minMajor;
  if (minor !== minMinor) return minor > minMinor;
  return patch >= minPatch;
}

describe('deterministic memory runtime prerequisites', () => {
  it('requires Node >=24.15.0 in both runtime and package metadata', () => {
    expect(versionAtLeast(process.version, [24, 15, 0])).toBe(true);
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      engines?: { node?: string };
    };
    expect(packageJson.engines?.node).toBe('>=24.15.0');
  });

  it('supports node:sqlite FTS5 MATCH and bm25 ranking', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE VIRTUAL TABLE memory_fts USING fts5(memory_id UNINDEXED, body)');
      const insert = db.prepare('INSERT INTO memory_fts(memory_id, body) VALUES (?, ?)');
      insert.run('m1', 'agent core deterministic memory fabric sqlite graph');
      insert.run('m2', 'ordinary launcher diagnostics');
      insert.run('m3', 'deterministic memory memory retrieval');

      const rows = db.prepare(
        `SELECT memory_id, bm25(memory_fts) AS score
           FROM memory_fts
          WHERE memory_fts MATCH ?
          ORDER BY score ASC, memory_id ASC`,
      ).all('deterministic memory') as Array<{ memory_id: string; score: number }>;

      expect(rows.map((row) => row.memory_id)).toEqual(['m3', 'm1']);
      expect(rows.every((row) => Number.isFinite(row.score))).toBe(true);
      expect(rows[0]!.score).toBeLessThan(rows[1]!.score);
    } finally {
      db.close();
    }
  });
});
