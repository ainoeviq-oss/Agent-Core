import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCatalog } from '../src/capabilities/catalog-parser.js';
import { writeRegistryGeneration } from '../src/capabilities/registry-writer.js';

const fixtureRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'capability-catalog',
);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('capability registry writer', () => {
  it('publishes canonical catalog, per-item files, and complete coverage', async () => {
    const capabilityDir = await mkdtemp(path.join(os.tmpdir(), 'agent-core-capabilities-'));
    roots.push(capabilityDir);
    const records = await parseCatalog(fixtureRoot, 'sha-good');

    const coverage = await writeRegistryGeneration(capabilityDir, records, {
      catalogSha: 'sha-good', generatedAt: '2026-08-22T00:00:00.000Z',
    });
    expect(coverage).toMatchObject({
      catalogSha: 'sha-good', total: 8, nativeReady: 0, unresolved: 0,
    });
    expect(coverage.byType).toMatchObject({ skill: 2, agent: 1, command: 1, hook: 1, framework: 3 });

    const catalog = JSON.parse(await readFile(path.join(capabilityDir, 'registry', 'catalog.json'), 'utf8'));
    expect(catalog.records).toHaveLength(8);
    expect(catalog.coverage.total).toBe(8);

    const item = JSON.parse(await readFile(
      path.join(capabilityDir, 'registry', 'items', `${records[0]!.id}.json`), 'utf8'));
    expect(item.id).toBe(records[0]!.id);
  });

  it('rejects a duplicate-id generation without replacing the previous good catalog', async () => {
    const capabilityDir = await mkdtemp(path.join(os.tmpdir(), 'agent-core-capabilities-'));
    roots.push(capabilityDir);
    const records = await parseCatalog(fixtureRoot, 'sha-good');
    await writeRegistryGeneration(capabilityDir, records, {
      catalogSha: 'sha-good', generatedAt: '2026-08-22T00:00:00.000Z',
    });
    const before = await readFile(path.join(capabilityDir, 'registry', 'catalog.json'), 'utf8');

    await expect(writeRegistryGeneration(capabilityDir, [...records, { ...records[0]! }], {
      catalogSha: 'sha-good', generatedAt: '2026-08-22T00:01:00.000Z',
    })).rejects.toThrow(/duplicate capability id/i);

    const after = await readFile(path.join(capabilityDir, 'registry', 'catalog.json'), 'utf8');
    expect(after).toBe(before);
  });
});
