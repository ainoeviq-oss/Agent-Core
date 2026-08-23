import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCatalog } from '../src/capabilities/catalog-parser.js';
import { CapabilityRegistry } from '../src/capabilities/registry-service.js';
import { writeRegistryGeneration } from '../src/capabilities/registry-writer.js';

const fixtureRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'capability-catalog',
);
const roots: string[] = [];

async function registryFixture() {
  const capabilityDir = await mkdtemp(path.join(os.tmpdir(), 'agent-core-cap-registry-'));
  roots.push(capabilityDir);
  const records = await parseCatalog(fixtureRoot, 'fixture-sha');
  await writeRegistryGeneration(capabilityDir, records, {
    catalogSha: 'fixture-sha', generatedAt: '2026-08-22T00:00:00.000Z',
  });
  return { capabilityDir, records };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe('CapabilityRegistry', () => {
  it('searches compact metadata with filters without expanding skill instructions', async () => {
    const { capabilityDir } = await registryFixture();
    const registry = CapabilityRegistry.open(capabilityDir);

    const results = registry.search('빌드 오류', { type: 'skill', category: 'debugging' });
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results.every((item) => item.type === 'skill' && item.category === 'debugging')).toBe(true);
    expect(results[0]).toMatchObject({ name: 'build-fix', state: 'cataloged' });
    expect(results[0]).not.toHaveProperty('instructions');
  });

  it('recommends deterministically from task text and reports complete coverage', async () => {
    const { capabilityDir } = await registryFixture();
    const registry = CapabilityRegistry.open(capabilityDir);

    const first = registry.recommend('빌드 오류를 수정해줘', 'debugging project');
    const second = registry.recommend('빌드 오류를 수정해줘', 'debugging project');
    expect(first.length).toBeGreaterThan(0);
    expect(first[0]!.name).toBe('build-fix');
    expect(first.map((item) => item.id)).toEqual(second.map((item) => item.id));
    expect(registry.coverage()).toMatchObject({ total: 8, catalogSha: 'fixture-sha' });
  });

  it('rejects skill loading before native-ready audit gates pass', async () => {
    const { capabilityDir, records } = await registryFixture();
    const registry = CapabilityRegistry.open(capabilityDir);
    const skill = records.find((record) => record.type === 'skill')!;

    expect(() => registry.loadSkill(skill.id)).toThrow(/not native-ready/i);
  });

  it('loads full instructions only for an audited native-ready skill', async () => {
    const { capabilityDir, records } = await registryFixture();
    const index = records.findIndex((record) => record.type === 'skill');
    const skill = records[index]!;
    const relative = path.join('normalized', 'skills', skill.id, 'SKILL.md');
    const fullPath = path.join(capabilityDir, relative);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, '# Build Fix\n\nFollow the audited workflow.\n', 'utf8');
    records[index] = {
      ...skill,
      state: 'native_ready',
      nativeEligible: true,
      risk: 'low',
      license: { status: 'verified', id: 'MIT' },
      normalizedPath: relative,
    };
    await writeRegistryGeneration(capabilityDir, records, {
      catalogSha: 'fixture-sha', generatedAt: '2026-08-22T00:02:00.000Z',
    });

    const registry = CapabilityRegistry.open(capabilityDir);
    const loaded = registry.loadSkill(skill.id);
    expect(loaded.instructions).toContain('Follow the audited workflow.');
    expect(loaded.capability).toMatchObject({ id: skill.id, state: 'native_ready' });
  });

  it('opens as an empty registry when no published catalog exists', async () => {
    const capabilityDir = await mkdtemp(path.join(os.tmpdir(), 'agent-core-cap-empty-'));
    roots.push(capabilityDir);
    const registry = CapabilityRegistry.open(capabilityDir);
    expect(registry.coverage()).toMatchObject({ total: 0, catalogSha: 'none' });
    expect(registry.search('anything')).toEqual([]);
  });
});
