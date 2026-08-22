import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCatalog } from '../src/capabilities/catalog-parser.js';

const fixtureRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'capability-catalog',
);

describe('capability catalog parser', () => {
  it('parses typed rows and umbrella rows into complete catalog records', async () => {
    const records = await parseCatalog(fixtureRoot, 'catalog-sha-1');

    expect(records).toHaveLength(8);
    expect(records.map((record) => record.type)).toEqual(expect.arrayContaining([
      'agent', 'skill', 'command', 'hook', 'framework',
    ]));

    const buildFix = records.find((record) =>
      record.name === 'build-fix' && record.source.repo === 'example/skills');
    expect(buildFix).toMatchObject({
      category: 'debugging',
      declaredPurpose: '빌드 오류 수정',
      functionalSummary: '빌드 오류 수정',
      compatibility: ['CC', 'CX'],
      language: ['한국어'],
      state: 'cataloged',
      risk: 'unknown',
      nativeEligible: false,
      catalogSha: 'catalog-sha-1',
    });
    expect(buildFix?.source).toMatchObject({
      url: 'https://github.com/example/skills/tree/main/build-fix',
      repo: 'example/skills',
      path: 'build-fix',
      sha: null,
    });
    expect(buildFix?.triggers.length).toBeGreaterThan(0);
    expect(buildFix?.inputsContext).toEqual(['task_context']);
    expect(buildFix?.outputsArtifacts).toEqual(['unknown_from_catalog']);
    expect(buildFix?.license).toEqual({ status: 'unknown', id: null });
  });

  it('keeps duplicate display names distinct by provenance and produces deterministic ids', async () => {
    const first = await parseCatalog(fixtureRoot, 'catalog-sha-1');
    const second = await parseCatalog(fixtureRoot, 'catalog-sha-1');
    const duplicates = first.filter((record) => record.name === 'build-fix');

    expect(duplicates).toHaveLength(2);
    expect(new Set(duplicates.map((record) => record.id)).size).toBe(2);
    expect(first.map((record) => record.id)).toEqual(second.map((record) => record.id));
  });

  it('preserves case-variant duplicate rows with distinct ids and a shared equivalence group', async () => {
    const records = await parseCatalog(fixtureRoot, 'catalog-sha-1');
    const variants = records.filter((record) => record.name.toLowerCase() === 'suite-one');

    expect(variants).toHaveLength(2);
    expect(new Set(variants.map((record) => record.id)).size).toBe(2);
    expect(variants[0]!.equivalenceGroup).not.toBeNull();
    expect(variants[0]!.equivalenceGroup).toBe(variants[1]!.equivalenceGroup);
  });
  it('maps top-level framework rows to reference capabilities with category-level purpose', async () => {
    const records = await parseCatalog(fixtureRoot, 'catalog-sha-1');
    const suite = records.find((record) => record.name === 'suite-one');

    expect(suite).toMatchObject({
      type: 'framework',
      category: 'frameworks',
      compatibility: ['CC', 'GC'],
      language: ['영+한'],
      invocation: 'reference_only',
    });
    expect(suite?.declaredPurpose).toContain('설치하면 에이전트');
    expect(suite?.declaredPurpose).toContain('5 skills');
  });
});
