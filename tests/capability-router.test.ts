import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CapabilityRegistry } from '../src/capabilities/registry-service.js';
import { writeRegistryGeneration } from '../src/capabilities/registry-writer.js';
import { CapabilityRouter } from '../src/capabilities/router.js';
import type { CapabilityRecord } from '../src/capabilities/types.js';

const roots: string[] = [];

function record(
  id: string,
  name: string,
  overrides: Partial<CapabilityRecord> = {},
): CapabilityRecord {
  return {
    id,
    name,
    displayName: name,
    aliases: [],
    type: 'skill',
    category: 'general',
    categoryTitle: 'General',
    declaredPurpose: `Support ${name} workflows`,
    functionalSummary: `Provide guidance for ${name}`,
    source: {
      url: `https://example.test/${id}`,
      repo: 'example/test',
      path: null,
      sha: 'fixture-sha',
    },
    compatibility: ['chatgpt'],
    language: ['en'],
    triggers: [],
    invocation: 'auto_candidate',
    inputsContext: [],
    outputsArtifacts: [],
    requiredTools: [],
    dependencies: [],
    sideEffects: [],
    risk: 'low',
    license: { status: 'verified', id: 'MIT' },
    state: 'cataloged',
    nativeEligible: false,
    normalizedPath: null,
    equivalenceGroup: null,
    catalogSha: 'fixture-sha',
    catalogFile: 'fixture.md',
    catalogRow: 1,
    ...overrides,
  };
}
async function routerFixture(): Promise<CapabilityRouter> {
  const capabilityDir = await mkdtemp(path.join(os.tmpdir(), 'agent-core-router-'));
  roots.push(capabilityDir);
  const records: CapabilityRecord[] = [
    record('frontend-quality', 'frontend-quality', {
      category: 'frontend',
      categoryTitle: 'Frontend',
      declaredPurpose: 'Improve frontend dashboard visual hierarchy spacing and layout',
      functionalSummary: 'Refactor frontend presentation quality and visual hierarchy',
      aliases: ['frontend design'],
      triggers: ['frontend', 'dashboard', 'spacing', 'hierarchy', 'refactor'],
      state: 'native_ready',
      nativeEligible: true,
      normalizedPath: 'normalized/skills/frontend-quality/SKILL.md',
    }),
    record('backend-debug-reference', 'backend-debug-reference', {
      category: 'debugging',
      categoryTitle: 'Debugging',
      declaredPurpose: 'Debug backend crashes and investigate runtime failures',
      functionalSummary: 'Diagnose backend crash failures with structured debugging',
      triggers: ['debug', 'backend', 'crash', 'failure'],
      state: 'reference_only',
      invocation: 'reference_only',
    }),
    record('docs-helper', 'docs-helper', {
      category: 'documentation',
      categoryTitle: 'Documentation',
      declaredPurpose: 'Write API reference documentation and changelogs',
      functionalSummary: 'Improve technical documentation wording',
      triggers: ['documentation', 'changelog'],
      state: 'native_ready',
      nativeEligible: true,
      normalizedPath: 'normalized/skills/docs-helper/SKILL.md',
    }),
  ];
  await writeRegistryGeneration(capabilityDir, records, {
    catalogSha: 'fixture-sha',
    generatedAt: '2026-08-23T00:00:00.000Z',
  });
  return new CapabilityRouter(CapabilityRegistry.open(capabilityDir));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('CapabilityRouter', () => {
  it('routes a narrow direct mutation as atomic without loading a skill', async () => {
    const router = await routerFixture();
    const result = router.route('Create notes.txt containing hello');
    expect(result).toMatchObject({
      tier: 'atomic',
      mode: 'atomic_direct',
      requiredSkillLoads: [],
      verification: { required: true },
    });
    expect(result.allowedTools).toContain('write_file');
  });

  it('requires a strongly relevant native-ready skill for domain-complex frontend work', async () => {
    const router = await routerFixture();
    const result = router.route(
      'Refactor this frontend dashboard to improve visual hierarchy and spacing',
    );

    expect(result).toMatchObject({
      tier: 'domain_complex',
      mode: 'skill_guided',
      domain: 'frontend',
      verification: { required: true },
    });
    expect(result.recommendedCapabilities[0]?.name).toBe('frontend-quality');
    expect(result.requiredSkillLoads).toEqual([
      { id: 'frontend-quality', name: 'frontend-quality' },
    ]);
  });
  it('keeps a stronger reference-only debugging capability as metadata guidance', async () => {
    const router = await routerFixture();
    const result = router.route('Debug this backend crash with a structured investigation');

    expect(result.tier).toBe('domain_complex');
    expect(result.recommendedCapabilities[0]?.name).toBe('backend-debug-reference');
    expect(result.requiredSkillLoads).toEqual([]);
    expect(result.mode).toBe('capability_guided');
  });

  it('returns deterministic decisions for identical task and context inputs', async () => {
    const router = await routerFixture();
    const task = 'Refactor this frontend dashboard and verify visual hierarchy';
    const context = 'React frontend workspace';

    const first = router.route(task, context);
    const second = router.route(task, context);

    expect(second).toEqual(first);
  });
  it('never requires a skill for atomic work even when context strongly matches a native skill', async () => {
    const router = await routerFixture();
    const result = router.route(
      'Create notes.txt containing hello',
      'frontend dashboard visual hierarchy spacing React frontend workspace',
    );

    expect(result.tier).toBe('atomic');
    expect(result.mode).toBe('atomic_direct');
    expect(result.requiredSkillLoads).toEqual([]);
  });

});
