import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CapabilityRecord } from '../src/capabilities/types.js';
import { writeRegistryGeneration } from '../src/capabilities/registry-writer.js';
import { buildAgentCorePluginPackage } from '../src/plugin/package-builder.js';

const roots: string[] = [];

async function tempRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-core-plugin-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function record(id: string, name: string, state: CapabilityRecord['state'], nativeEligible: boolean, normalizedPath: string | null): CapabilityRecord {
  return {
    id, name, displayName: name, aliases: [], type: 'skill', category: 'web-frontend', categoryTitle: 'Frontend',
    declaredPurpose: `${name} purpose`, functionalSummary: `${name} function`,
    source: { url: `https://example.invalid/${name}`, repo: `example/${name}`, path: 'SKILL.md', sha: 'source-sha' },
    compatibility: ['CX'], language: ['en'], triggers: [`intent:${name}`], invocation: 'auto_candidate',
    inputsContext: ['task_context'], outputsArtifacts: [], requiredTools: ['read_file'], dependencies: [], sideEffects: [],
    risk: 'low', license: { status: 'verified', id: 'Apache-2.0' }, state, nativeEligible, normalizedPath,
    equivalenceGroup: null, catalogSha: 'fixture-sha', catalogFile: 'fixture.md', catalogRow: 1,
  };
}

async function setupPackageFixture() {
  const root = await tempRoot();
  const capabilityDir = path.join(root, 'capabilities');
  const outputDir = path.join(root, 'plugin-output');
  const nativeDir = path.join(capabilityDir, 'normalized', 'skills', 'cap_native');
  const provenanceDir = path.join(capabilityDir, 'provenance');
  const cacheRepo = path.join(capabilityDir, 'cache', 'sources', 'repos', 'native-skill');
  await Promise.all([
    mkdir(nativeDir, { recursive: true }),
    mkdir(provenanceDir, { recursive: true }),
    mkdir(cacheRepo, { recursive: true }),
  ]);
  await writeFile(path.join(nativeDir, 'SKILL.md'), '# Native Skill\n\nAudited instructions.\n', 'utf8');
  await writeFile(path.join(cacheRepo, 'LICENSE'), 'Apache License\nVersion 2.0, January 2004\n', 'utf8');
  await writeFile(path.join(provenanceDir, 'cap_native.json'), JSON.stringify({
    capabilityId: 'cap_native',
    sourceRepo: 'example/native-skill',
    sourceUrl: 'https://example.invalid/native-skill',
    sourceCommitSha: 'source-sha',
    licensePath: path.join(cacheRepo, 'LICENSE'),
    license: { status: 'verified', id: 'Apache-2.0' },
    risk: 'low', functionAnalyzed: true, safetyReviewed: true,
  }), 'utf8');
  await writeRegistryGeneration(capabilityDir, [
    record('cap_native', 'native-skill', 'native_ready', true, 'normalized/skills/cap_native/SKILL.md'),
    record('cap_cataloged', 'catalog-only', 'cataloged', false, null),
  ], { catalogSha: 'fixture-sha', generatedAt: '2026-08-22T00:00:00.000Z' });

  const routerSkillPath = path.resolve('plugin', 'agent-core', 'skills', 'agent-core-capability-router', 'SKILL.md');
  const githubSkillPath = path.resolve('plugin', 'agent-core', 'skills', 'agent-core-github', 'SKILL.md');
  return { root, capabilityDir, outputDir, routerSkillPath, githubSkillPath };
}

describe('Agent Core plugin package builder', () => {
  it('packages the tracked router + github skills plus audited native-ready skills only', async () => {
    const { capabilityDir, outputDir, routerSkillPath, githubSkillPath } = await setupPackageFixture();
    const result = await buildAgentCorePluginPackage({ capabilityDir, outputDir, routerSkillPath, githubSkillPath });
    expect(result.nativeSkillCount).toBe(1);
    expect(result.skills).toEqual(expect.arrayContaining(['agent-core-capability-router', 'agent-core-github', 'native-skill']));

    const router = await readFile(path.join(outputDir, 'skills', 'agent-core-capability-router', 'SKILL.md'), 'utf8');
    const trackedRouter = await readFile(routerSkillPath, 'utf8');
    expect(router).toBe(trackedRouter);
    expect(router).toContain('capability_route');
    expect(router).toContain('routeContextId');
    expect(router).toContain('skill_load(id, routeContextId)');
    expect(router).not.toMatch(/\b(?:ask|tell|require|instruct)\s+(?:the\s+)?user\b[^.\n]{0,120}\b(?:mention|name|invoke|call)\b[^.\n]{0,120}\b(?:capability_route|routeContextId|skill_load)\b/i);
    const github = await readFile(path.join(outputDir, 'skills', 'agent-core-github', 'SKILL.md'), 'utf8');
    expect(github).toBe(await readFile(githubSkillPath, 'utf8'));
    expect(github).toContain('github_api');
    expect(github).toContain('github_git');
    expect(github).not.toContain('gh-token.txt contents');
    const native = await readFile(path.join(outputDir, 'skills', 'native-skill', 'SKILL.md'), 'utf8');
    expect(native).toContain('Audited instructions');
    await expect(readFile(path.join(outputDir, 'skills', 'catalog-only', 'SKILL.md'), 'utf8')).rejects.toThrow();
  });

  it('carries provenance and required license material beside each imported third-party skill', async () => {
    const { capabilityDir, outputDir, routerSkillPath, githubSkillPath } = await setupPackageFixture();
    await buildAgentCorePluginPackage({ capabilityDir, outputDir, routerSkillPath, githubSkillPath });

    const provenance = JSON.parse(await readFile(
      path.join(outputDir, 'skills', 'native-skill', 'PROVENANCE.json'), 'utf8',
    )) as Record<string, unknown>;
    expect(provenance).toMatchObject({ capabilityId: 'cap_native', sourceCommitSha: 'source-sha' });
    const license = await readFile(path.join(outputDir, 'skills', 'native-skill', 'LICENSE'), 'utf8');
    expect(license).toContain('Apache License');
  });

  it('documents the existing Agent Core app without embedding secrets or runtime caches', async () => {
    const { capabilityDir, outputDir, routerSkillPath, githubSkillPath } = await setupPackageFixture();
    await buildAgentCorePluginPackage({ capabilityDir, outputDir, routerSkillPath, githubSkillPath });

    const packageMeta = JSON.parse(await readFile(path.join(outputDir, 'agent-core-package.json'), 'utf8')) as Record<string, any>;
    expect(packageMeta.app).toMatchObject({
      name: 'Agent Core',
      protocol: 'mcp',
      endpoint: '/mcp',
    });
    expect(packageMeta.skills).toEqual(expect.arrayContaining(['agent-core-capability-router', 'agent-core-github']));
    const serialized = JSON.stringify(packageMeta).toLowerCase();
    expect(serialized).not.toContain('api_key');
    expect(serialized).not.toContain('agent_core_live_');
    expect(serialized).not.toContain('oauth.json');
    expect(serialized).not.toContain('control-plane-api-key');
    expect(serialized).not.toContain('gh-token.txt');
    expect(serialized).not.toContain('packages-token.txt');

    const packagedPaths = (await readdir(outputDir, { recursive: true }))
      .map((entry) => String(entry).replaceAll('\\\\', '/').toLowerCase());
    for (const candidate of packagedPaths) {
      expect(candidate).not.toMatch(/(^|\/)(secrets?|runtime|cache)(\/|$)/);
      expect(candidate).not.toMatch(/(?:gh-token|packages-token|oauth\.json|control-plane-api-key)/);
    }
  });

  it('keeps the stable release builder explicitly credential-free while packaging the github skill', async () => {
    const releaseBuilder = await readFile(path.resolve('scripts', 'release', 'build-release.ps1'), 'utf8');
    expect(releaseBuilder).toContain("skills\\agent-core-github");
    expect(releaseBuilder).toContain("skills = @('agent-core-capability-router','agent-core-github')");
    expect(releaseBuilder).toContain("exclusions = @('secrets'");
    expect(releaseBuilder).not.toContain('gh-token.txt');
    expect(releaseBuilder).not.toContain('packages-token.txt');
  });
});
