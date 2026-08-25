import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type AppConfig, type MemoryConfig } from '../src/config.js';
import { startAgentCoreService, type AgentCoreService } from '../src/index.js';
import { MemoryService } from '../src/memory/service.js';
import { MemoryStoreError } from '../src/memory/store.js';

interface AwarenessScenarios {
  scenarioA: { query: string; oldAgeMs: number };
  scenarioB: { canonicalKey: string; query: string; oldValue: string; newValue: string };
  scenarioC: { query: string };
  scenarioD: { query: string };
  scenarioE: { query: string };
  scenarioF: { query: string };
  scenarioG: { task: string; context: string };
  scenarioH: { query: string };
}

const scenarios = JSON.parse(await readFile(
  new URL('./fixtures/memory-awareness/scenarios.json', import.meta.url),
  'utf8',
)) as AwarenessScenarios;

const roots: string[] = [];
const memoryServices: MemoryService[] = [];
const agentServices: AgentCoreService[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), 'agent-core-awareness-'));
  roots.push(root);
  return root;
}

function memoryConfig(root: string, overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  return {
    ...loadConfig({}, root).memory,
    enabled: true,
    dbPath: path.join(root, 'runtime', 'memory', 'awareness.sqlite'),
    graphMaxHops: 4,
    recallItemBudget: 32,
    recallCharacterBudget: 20_000,
    temporalNeighborWindowMs: 1,
    ...overrides,
  };
}

function memoryService(config: MemoryConfig): MemoryService {
  const service = new MemoryService(config);
  memoryServices.push(service);
  return service;
}

function scope(root: string, project = 'project-a') {
  return {
    principalId: 'awareness-principal',
    projectId: path.join(root, project),
  };
}

async function delay(ms = 5): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function ageMemory(dbPath: string, memoryId: string, updatedAt: number): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 1000');
    db.prepare('UPDATE memory_items SET updated_at = ?, last_accessed_at = ?, access_count = 0 WHERE id = ?')
      .run(updatedAt, updatedAt, memoryId);
  } finally {
    db.close();
  }
}

function appConfig(root: string): AppConfig {
  const base = loadConfig({}, root);
  return {
    ...base,
    host: '127.0.0.1',
    port: 0,
    memory: memoryConfig(root),
  };
}

afterEach(async () => {
  await Promise.all(agentServices.splice(0).map(async (service) => {
    try { await service.close(); } catch {}
  }));
  await Promise.all(memoryServices.splice(0).map(async (service) => {
    try { await service.close(); } catch {}
  }));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('deterministic long-term memory awareness acceptance', () => {
  it('Scenario A: an old pinned hard project guardrail outranks fresh related chatter', async () => {
    const root = await tempRoot();
    const config = memoryConfig(root);
    const projectScope = scope(root);
    const service = memoryService(config);

    const guardrail = await service.commit({
      scope: projectScope,
      canonicalKey: 'guardrail.storage.drive',
      kind: 'guardrail',
      value: 'Workspace build output must stay on drive F.',
      importance: 1,
      pinned: true,
      enforcement: 'hard',
      sourceType: 'acceptance',
    });
    const chatterIds: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      await delay();
      const chatter = await service.commit({
        scope: projectScope,
        canonicalKey: `observation.storage.chatter.${index}`,
        kind: 'observation',
        value: `Workspace build output drive F chatter ${index} about preview timing and packaging notes.`,
        importance: 0.4,
        sourceType: 'acceptance',
      });
      chatterIds.push(chatter.memoryId);
    }

    await service.close();
    ageMemory(config.dbPath, guardrail.memoryId, Date.now() - scenarios.scenarioA.oldAgeMs);
    const reopened = memoryService(config);
    const recalled = await reopened.search({ scope: projectScope, query: scenarios.scenarioA.query, limit: 10 });

    expect(recalled.hits[0]?.memoryId).toBe(guardrail.memoryId);
    expect(recalled.hits[0]).toMatchObject({ kind: 'guardrail', enforcement: 'hard', pinned: true });
    expect(recalled.hits.some((hit) => chatterIds.includes(hit.memoryId))).toBe(true);
  });

  it('Scenario B: a changed decision recalls only the newest active revision while preserving history', async () => {
    const root = await tempRoot();
    const service = memoryService(memoryConfig(root));
    const projectScope = scope(root);
    const decision = await service.commit({
      scope: projectScope,
      canonicalKey: scenarios.scenarioB.canonicalKey,
      kind: 'decision',
      value: scenarios.scenarioB.oldValue,
      importance: 0.9,
      sourceType: 'acceptance',
    });
    const revised = await service.revise({
      scope: projectScope,
      memoryId: decision.memoryId,
      value: scenarios.scenarioB.newValue,
      sourceType: 'acceptance-change',
    });

    const recalled = await service.search({ scope: projectScope, query: scenarios.scenarioB.query, limit: 5 });
    const hit = recalled.hits.find((item) => item.memoryId === decision.memoryId);
    expect(hit?.revisionNo).toBe(revised.revisionNo);
    expect(hit?.valueText).toContain('renderer B');
    expect(hit?.valueText).not.toContain('renderer A');

    const revisions = await service.listRevisions(projectScope, decision.memoryId);
    expect(revisions.map((item) => item.valueText)).toEqual([
      expect.stringContaining('renderer A'),
      expect.stringContaining('renderer B'),
    ]);
  });

  it('Scenario C: a failure from an earlier run is recalled before repeating the same action', async () => {
    const root = await tempRoot();
    const service = memoryService(memoryConfig(root));
    const projectScope = scope(root);
    const failure = await service.commit({
      scope: projectScope,
      canonicalKey: 'failure.write_file.build_output_zip',
      kind: 'failure',
      value: 'write_file build-output.zip failed because access denied while writing the artifact.',
      importance: 0.85,
      sourceType: 'operational_failure',
      sourceRef: 'earlier-run',
    });

    const preflight = await service.preflight({
      scope: projectScope,
      routeContextId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      task: scenarios.scenarioC.query,
      expiresAt: Date.now() + 60_000,
    });
    expect(preflight.priorFailures.map((item) => item.memoryId)).toContain(failure.memoryId);
    expect(preflight.recalled.find((item) => item.memoryId === failure.memoryId)?.sourceEventId).toBeTruthy();
  });

  it('Scenario D: graph recall follows project → artifact → decision → tool constraint across multiple hops', async () => {
    const root = await tempRoot();
    const service = memoryService(memoryConfig(root, { graphMaxHops: 4, temporalNeighborWindowMs: 1 }));
    const projectScope = scope(root);

    const project = await service.commit({
      scope: projectScope,
      canonicalKey: 'project.chain',
      kind: 'project_state',
      value: 'Primary project root context marker.',
      sourceType: 'acceptance',
    });
    await delay();
    const artifact = await service.commit({
      scope: projectScope,
      canonicalKey: 'artifact.bundle',
      kind: 'artifact',
      value: 'Artifact manifest for release bundle.',
      sourceType: 'acceptance',
      explicitRelations: [{ targetMemoryId: project.memoryId, relation: 'explicit_relation' }],
    });
    await delay();
    const decision = await service.commit({
      scope: projectScope,
      canonicalKey: 'decision.compiler',
      kind: 'decision',
      value: 'Selected compile flow for the release.',
      sourceType: 'acceptance',
      explicitRelations: [{ targetMemoryId: artifact.memoryId, relation: 'explicit_relation' }],
    });
    await delay();
    const constraint = await service.commit({
      scope: projectScope,
      canonicalKey: 'guardrail.tool.constraint',
      kind: 'guardrail',
      value: 'Tool constraint: never invoke destructive_write_tool.',
      pinned: true,
      enforcement: 'hard',
      importance: 1,
      sourceType: 'acceptance',
      explicitRelations: [{ targetMemoryId: decision.memoryId, relation: 'explicit_relation' }],
    });

    const recalled = await service.search({ scope: projectScope, query: scenarios.scenarioD.query, limit: 10 });
    const hit = recalled.hits.find((item) => item.memoryId === constraint.memoryId);
    expect(hit).toBeTruthy();
    expect(hit?.whyMatched.graph).toBeGreaterThan(0);
    expect(hit?.whyMatched.graphPath).toEqual([
      project.memoryId,
      artifact.memoryId,
      decision.memoryId,
      constraint.memoryId,
    ]);
  });

  it('Scenario E: unrelated projects under the same principal never cross-contaminate recall', async () => {
    const root = await tempRoot();
    const service = memoryService(memoryConfig(root));
    const projectA = scope(root, 'project-a');
    const projectB = scope(root, 'project-b');
    const memoryA = await service.commit({
      scope: projectA,
      canonicalKey: 'guardrail.deployment.region',
      kind: 'guardrail',
      value: 'Deployment region for project A is Jakarta.',
      sourceType: 'acceptance',
    });
    const memoryB = await service.commit({
      scope: projectB,
      canonicalKey: 'guardrail.deployment.region',
      kind: 'guardrail',
      value: 'Deployment region for project B is Singapore.',
      sourceType: 'acceptance',
    });

    const recalledA = await service.search({ scope: projectA, query: scenarios.scenarioE.query, limit: 10 });
    const recalledB = await service.search({ scope: projectB, query: scenarios.scenarioE.query, limit: 10 });
    expect(recalledA.hits.map((item) => item.memoryId)).toContain(memoryA.memoryId);
    expect(recalledA.hits.map((item) => item.memoryId)).not.toContain(memoryB.memoryId);
    expect(recalledB.hits.map((item) => item.memoryId)).toContain(memoryB.memoryId);
    expect(recalledB.hits.map((item) => item.memoryId)).not.toContain(memoryA.memoryId);
  });

  it('Scenario F: ambiguous free-form contradiction is surfaced as conflict and neither branch is overwritten', async () => {
    const root = await tempRoot();
    const service = memoryService(memoryConfig(root));
    const projectScope = scope(root);
    const left = await service.commit({
      scope: projectScope,
      canonicalKey: 'observation.deploy.behavior.one',
      kind: 'observation',
      value: 'Deployment behavior evidence says the artifact was rebuilt.',
      sourceType: 'acceptance',
    });
    const right = await service.commit({
      scope: projectScope,
      canonicalKey: 'observation.deploy.behavior.two',
      kind: 'observation',
      value: 'Deployment behavior evidence says the artifact was not rebuilt.',
      sourceType: 'acceptance',
    });

    await service.openConflict(projectScope, left.memoryId, right.memoryId, 'ambiguous_freeform', {
      reason: 'Conflicting free-form evidence requires explicit resolution.',
    });
    const preflight = await service.preflight({
      scope: projectScope,
      routeContextId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      task: scenarios.scenarioF.query,
      expiresAt: Date.now() + 60_000,
    });

    expect(preflight.openConflicts).toHaveLength(1);
    expect(new Set([
      preflight.openConflicts[0]?.leftMemoryId,
      preflight.openConflicts[0]?.rightMemoryId,
    ])).toEqual(new Set([left.memoryId, right.memoryId]));
    expect((await service.getMemory(projectScope, left.memoryId))?.valueText).toContain('was rebuilt');
    expect((await service.getMemory(projectScope, right.memoryId))?.valueText).toContain('was not rebuilt');
    expect((await service.getMemory(projectScope, left.memoryId))?.state).toBe('conflicted');
    expect((await service.getMemory(projectScope, right.memoryId))?.state).toBe('conflicted');
  });

  it('Scenario G: repeating the same route query produces identical ordered recall and snapshot hash', async () => {
    const root = await tempRoot();
    const service = memoryService(memoryConfig(root));
    const projectScope = scope(root);
    await service.commit({
      scope: projectScope,
      canonicalKey: 'procedure.release.bundle',
      kind: 'procedure',
      value: 'Deterministic release procedure uses artifact bundle generation and verification.',
      sourceType: 'acceptance',
    });
    await service.commit({
      scope: projectScope,
      canonicalKey: 'decision.release.verify',
      kind: 'decision',
      value: 'Release artifact bundle generation must be followed by verification.',
      sourceType: 'acceptance',
    });

    const first = await service.preflight({
      scope: projectScope,
      routeContextId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      task: scenarios.scenarioG.task,
      context: scenarios.scenarioG.context,
      expiresAt: Date.now() + 60_000,
    });
    const second = await service.preflight({
      scope: projectScope,
      routeContextId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      task: scenarios.scenarioG.task,
      context: scenarios.scenarioG.context,
      expiresAt: Date.now() + 60_000,
    });

    expect(second.recalled.map((item) => item.memoryId)).toEqual(first.recalled.map((item) => item.memoryId));
    expect(second.recalled.map((item) => item.revisionId)).toEqual(first.recalled.map((item) => item.revisionId));
    expect(second.snapshotHash).toBe(first.snapshotHash);
  });

  it('Scenario H: restarting Agent Core rehydrates the same DB and returns the same recall result IDs', async () => {
    const root = await tempRoot();
    const config = appConfig(root);
    const projectScope = scope(root);
    const firstAgent = await startAgentCoreService(config);
    agentServices.push(firstAgent);
    await firstAgent.memory.commit({
      scope: projectScope,
      canonicalKey: 'guardrail.restart.persistent.policy',
      kind: 'guardrail',
      value: 'Restart persistent policy keeps the deterministic memory database reusable.',
      pinned: true,
      enforcement: 'hard',
      sourceType: 'acceptance',
    });
    await firstAgent.memory.commit({
      scope: projectScope,
      canonicalKey: 'decision.restart.persistence',
      kind: 'decision',
      value: 'Restart persistent policy uses the same database path after service restart.',
      sourceType: 'acceptance',
    });
    const before = await firstAgent.memory.search({ scope: projectScope, query: scenarios.scenarioH.query, limit: 10 });
    await firstAgent.close();
    agentServices.splice(agentServices.indexOf(firstAgent), 1);

    const secondAgent = await startAgentCoreService(config);
    agentServices.push(secondAgent);
    const after = await secondAgent.memory.search({ scope: projectScope, query: scenarios.scenarioH.query, limit: 10 });
    expect(after.hits.map((item) => item.memoryId)).toEqual(before.hits.map((item) => item.memoryId));
    expect(after.hits.map((item) => item.revisionId)).toEqual(before.hits.map((item) => item.revisionId));
    expect(after.snapshotHash).toBe(before.snapshotHash);
    expect((await secondAgent.memory.status(projectScope)).healthy).toBe(true);
  });

  it('also refuses silent overwrite when a structured mutable key changes without revision authority', async () => {
    const root = await tempRoot();
    const service = memoryService(memoryConfig(root));
    const projectScope = scope(root);
    await service.commit({
      scope: projectScope,
      canonicalKey: 'decision.explicit.revision.guard',
      kind: 'decision',
      value: 'Decision version one.',
      sourceType: 'acceptance',
    });
    await expect(service.commit({
      scope: projectScope,
      canonicalKey: 'decision.explicit.revision.guard',
      kind: 'decision',
      value: 'Decision version two.',
      sourceType: 'acceptance',
    })).rejects.toEqual(expect.objectContaining<Partial<MemoryStoreError>>({ code: 'MEMORY_REVISION_REQUIRED' }));
  });
});
