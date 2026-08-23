import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CapabilityRecord } from '../src/capabilities/types.js';
import { writeRegistryGeneration } from '../src/capabilities/registry-writer.js';
import { FileAuditLogger } from '../src/logging/audit-log.js';
import { createRuntimeServices } from '../src/runtime/services.js';

const roots: string[] = [];
const SENTINEL_TASK = 'SENTINEL_USER_TASK_8d14';
const SENTINEL_SECRET = 'SENTINEL_API_SECRET_5f27';
const SENTINEL_OAUTH = 'SENTINEL_OAUTH_TOKEN_91ac';
const SENTINEL_SKILL_BODY = 'SENTINEL_SKILL_BODY_c204';

function frontendCapability(): CapabilityRecord {
  return {
    id: 'frontend-quality', name: 'frontend-quality', displayName: 'Frontend Quality',
    aliases: ['frontend design'], type: 'skill', category: 'frontend', categoryTitle: 'Frontend',
    declaredPurpose: 'Improve frontend dashboard hierarchy spacing and layout',
    functionalSummary: 'Refactor frontend visual hierarchy',
    source: { url: 'https://example.invalid/frontend', repo: 'example/frontend', path: 'SKILL.md', sha: 'sha' },
    compatibility: ['chatgpt'], language: ['en'],
    triggers: ['frontend', 'dashboard', 'spacing', 'hierarchy', 'refactor'],
    invocation: 'auto_candidate', inputsContext: ['task_context'], outputsArtifacts: [],
    requiredTools: ['read_file'], dependencies: [], sideEffects: [], risk: 'low',
    license: { status: 'verified', id: 'MIT' }, state: 'native_ready', nativeEligible: true,
    normalizedPath: 'normalized/skills/frontend-quality/SKILL.md', equivalenceGroup: null,
    catalogSha: 'fixture-sha', catalogFile: 'fixture.md', catalogRow: 1,
  };
}

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-core-routing-audit-'));
  roots.push(root);
  const capabilityDir = path.join(root, 'capabilities');
  const skillPath = path.join(
    capabilityDir, 'normalized', 'skills', 'frontend-quality', 'SKILL.md',
  );
  await mkdir(path.dirname(skillPath), { recursive: true });
  await writeFile(skillPath, `# Frontend\n\n${SENTINEL_SKILL_BODY}\n`, 'utf8');
  await writeRegistryGeneration(capabilityDir, [frontendCapability()], {
    catalogSha: 'fixture-sha', generatedAt: '2026-08-23T00:00:00.000Z',
  });
  const logger = new FileAuditLogger(path.join(root, 'logs'));
  return {
    root,
    logger,
    runtime: createRuntimeServices([root], capabilityDir, logger),
  };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Agent Core routing audit', () => {
  it('records only routing metadata for create, load, validate, and reject flows', async () => {
    const { runtime, logger } = await setup();
    const plan = runtime.router.route(
      `Refactor this frontend dashboard ${SENTINEL_TASK}`,
      `workspace context ${SENTINEL_SECRET} ${SENTINEL_OAUTH}`,
    );
    const route = runtime.routes.create('principal-a', plan);

    const loaded = runtime.capabilities.loadSkill('frontend-quality');
    expect(loaded.instructions).toContain(SENTINEL_SKILL_BODY);
    runtime.routes.markSkillLoaded(route.routeContextId, 'principal-a', 'frontend-quality');
    runtime.routes.validate(route.routeContextId, 'principal-a', 'write_file');

    expect(() => runtime.routes.validate(
      route.routeContextId,
      'principal-a',
      'unknown_tool',
    )).toThrow();

    const auditText = await readFile(logger.filePath, 'utf8');
    const events = auditText.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(events.map((event) => event.event)).toEqual([
      'route.created',
      'route.skill_loaded',
      'route.validated',
      'route.rejected',
    ]);
    expect(events[0]).toMatchObject({
      routeContextId: route.routeContextId,
      principalId: 'principal-a',
      tier: 'domain_complex',
      mode: 'skill_guided',
      risk: 'low',
      capabilityIds: ['frontend-quality'],
      skillIds: ['frontend-quality'],
    });
    expect(events[3]).toMatchObject({
      toolName: 'unknown_tool',
      errorCode: 'ROUTE_TOOL_NOT_ALLOWED',
    });

    for (const sentinel of [
      SENTINEL_TASK, SENTINEL_SECRET, SENTINEL_OAUTH, SENTINEL_SKILL_BODY,
    ]) {
      expect(auditText).not.toContain(sentinel);
    }
  });
});
