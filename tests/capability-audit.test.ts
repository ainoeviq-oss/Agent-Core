import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { auditSkillSource } from '../src/capabilities/source-audit.js';
import { normalizeAuditedSkill } from '../src/capabilities/skill-normalizer.js';

const fixtureRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures', 'audit',
);
const tempRoots: string[] = [];

async function tempDir() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'commander-cap-audit-'));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe('capability source audit', () => {
  it('verifies permissive license, function, tools, and low-risk behavior', async () => {
    const audit = await auditSkillSource({
      capabilityId: 'cap_safe',
      repoRoot: path.join(fixtureRoot, 'safe-repo'),
      skillPath: 'skills/safe-skill/SKILL.md',
      sourceRepo: 'fixture/safe-repo',
      sourceUrl: 'https://example.invalid/fixture/safe-repo',
      sourceCommitSha: 'fixture-safe-sha',
    });

    expect(audit.license).toMatchObject({ status: 'verified', id: 'MIT' });
    expect(audit.functionAnalyzed).toBe(true);
    expect(audit.safetyReviewed).toBe(true);
    expect(audit.risk).toBe('low');
    expect(audit.requiredTools).toEqual(expect.arrayContaining(['read_file', 'search_files', 'edit_file', 'execute_command']));
    expect(audit.eligible).toBe(true);
    expect(audit.sourceText).toContain('# Safe Skill');
  });

  it('blocks unknown-license sources from normalization', async () => {
    const audit = await auditSkillSource({
      capabilityId: 'cap_unknown',
      repoRoot: path.join(fixtureRoot, 'unknown-repo'),
      skillPath: 'skills/unknown-skill/SKILL.md',
      sourceRepo: 'fixture/unknown-repo',
      sourceUrl: 'https://example.invalid/fixture/unknown-repo',
      sourceCommitSha: 'fixture-unknown-sha',
    });

    expect(audit.license.status).toBe('unknown');
    expect(audit.eligible).toBe(false);
    await expect(normalizeAuditedSkill(audit, { capabilityDir: await tempDir() }))
      .rejects.toThrow(/license/i);
  });

  it('quarantines destructive automatic hook behavior even with MIT license', async () => {
    const audit = await auditSkillSource({
      capabilityId: 'cap_danger',
      repoRoot: path.join(fixtureRoot, 'dangerous-repo'),
      skillPath: 'skills/dangerous-skill/SKILL.md',
      sourceRepo: 'fixture/dangerous-repo',
      sourceUrl: 'https://example.invalid/fixture/dangerous-repo',
      sourceCommitSha: 'fixture-danger-sha',
    });

    expect(audit.license).toMatchObject({ status: 'verified', id: 'MIT' });
    expect(audit.risk).toBe('high');
    expect(audit.sideEffects).toContain('destructive_filesystem');
    expect(audit.eligible).toBe(false);
    await expect(normalizeAuditedSkill(audit, { capabilityDir: await tempDir() }))
      .rejects.toThrow(/risk/i);
  });

  it('ignores unreferenced repository docs when auditing a root SKILL.md', async () => {
    const audit = await auditSkillSource({
      capabilityId: 'cap_root_safe',
      repoRoot: path.join(fixtureRoot, 'root-safe-repo'),
      skillPath: 'SKILL.md',
      sourceRepo: 'fixture/root-safe-repo',
      sourceUrl: 'https://example.invalid/fixture/root-safe-repo',
      sourceCommitSha: 'fixture-root-safe-sha',
    });

    expect(audit.risk).toBe('low');
    expect(audit.sideEffects).not.toContain('network_access');
    expect(audit.sideEffects).not.toContain('package_installation');
    expect(audit.eligible).toBe(true);
  });

  it('preserves exact source text and writes normalized metadata plus provenance', async () => {
    const capabilityDir = await tempDir();
    const audit = await auditSkillSource({
      capabilityId: 'cap_safe',
      repoRoot: path.join(fixtureRoot, 'safe-repo'),
      skillPath: 'skills/safe-skill/SKILL.md',
      sourceRepo: 'fixture/safe-repo',
      sourceUrl: 'https://example.invalid/fixture/safe-repo',
      sourceCommitSha: 'fixture-safe-sha',
    });
    const normalized = await normalizeAuditedSkill(audit, { capabilityDir });

    expect(normalized.state).toBe('native_ready');
    const normalizedText = await readFile(normalized.skillPath, 'utf8');
    expect(normalizedText).toBe(audit.sourceText);
    await expect(stat(normalized.metadataPath)).resolves.toBeTruthy();
    await expect(stat(normalized.provenancePath)).resolves.toBeTruthy();
    const provenance = JSON.parse(await readFile(normalized.provenancePath, 'utf8')) as Record<string, unknown>;
    expect(provenance).toMatchObject({ capabilityId: 'cap_safe', sourceCommitSha: 'fixture-safe-sha' });
  });
});
