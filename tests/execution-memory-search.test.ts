import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ExecutionMemoryPreSearch, buildExecutionMemoryQuery } from '../src/execution/memory-search.js';
import { ExecutionService } from '../src/execution/service.js';
import { createRuntimeServices, type RuntimeServices } from '../src/runtime/services.js';
import { WorkspacePolicy } from '../src/runtime/workspace.js';
import { printCommand } from './helpers/platform-command.js';

const roots: string[] = [];
const runtimes: RuntimeServices[] = [];
const services: ExecutionService[] = [];

async function fixture(label: string, enforceHardGuardrails = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), `agent-core-execution-memory-search-${label}-`));
  roots.push(root);
  const work = path.join(root, 'work');
  await mkdir(work, { recursive: true });
  const defaults = loadConfig({}, root);
  const runtime = createRuntimeServices(
    [root],
    path.join(root, 'capabilities'),
    undefined,
    {
      ...defaults.memory,
      enabled: true,
      enforceHardGuardrails,
      dbPath: path.join(root, 'runtime', 'memory', `${label}.sqlite`),
    },
    {
      ...defaults.execution,
      enabled: true,
      dbPath: path.join(root, 'runtime', 'execution', `${label}.sqlite`),
      logRoot: path.join(root, 'runtime', 'execution', 'runs'),
    },
  );
  await runtime.execution.open();
  runtimes.push(runtime);
  return {
    root,
    work,
    runtime,
    scope: { principalId: `principal-${label}`, projectId: root },
  };
}

function percentile(values: number[], fraction: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1));
  return ordered[index] ?? 0;
}

async function eventually(assertion: () => void | Promise<void>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close().catch(() => undefined)));
  await Promise.all(runtimes.splice(0).map(async (runtime) => {
    await runtime.execution.close().catch(() => undefined);
    await runtime.memory.close().catch(() => undefined);
  }));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('autonomous execution memory pre-search', () => {
  it('builds a deterministic query from objective and node purpose only', () => {
    const query = buildExecutionMemoryQuery('  Build   release package  ', [
      { id: 'B', purpose: ' Verify release manifest ' },
      { id: 'A', purpose: ' Compile package ' },
    ]);
    expect(query).toBe('Build release package\nnode:A Compile package\nnode:B Verify release manifest');
    expect(query).not.toContain('command');
    expect(query).not.toContain('env');
  });

  it('blocks before a run is persisted when an enforced hard guardrail matches the execution objective', async () => {
    const f = await fixture('guardrail', true);
    const guardrail = await f.runtime.memory.commit({
      scope: f.scope,
      canonicalKey: 'guardrail.blocked.package.execution',
      kind: 'guardrail',
      value: 'Do not run blocked package deployment or build tasks.',
      enforcement: 'hard',
      importance: 1,
      pinned: true,
      sourceType: 'test',
    });

    await expect(f.runtime.execution.create(f.scope, {
      objective: 'Build and deploy the blocked package',
      nodes: [{ id: 'A', purpose: 'Build blocked package', command: printCommand('must-not-run'), cwd: f.work }],
    })).rejects.toMatchObject({
      code: 'EXECUTION_MEMORY_GUARDRAIL_BLOCKED',
      details: {
        guardrails: [expect.objectContaining({ memoryId: guardrail.memoryId })],
      },
    });
    expect(await f.runtime.execution.store.listRuns(f.scope, 100)).toEqual([]);
  });

  it('recalls prior failures and decisions before create/start without copying raw command text into the query', async () => {
    const f = await fixture('recall');
    const priorFailure = await f.runtime.memory.commit({
      scope: f.scope,
      canonicalKey: 'failure.package.stale.lock',
      kind: 'failure',
      value: 'Package build failed previously because a stale lock was reused.',
      importance: 0.95,
      sourceType: 'test',
    });
    const decision = await f.runtime.memory.commit({
      scope: f.scope,
      canonicalKey: 'decision.package.local.build',
      kind: 'decision',
      value: 'Use the established local clean build path for package work.',
      importance: 0.95,
      sourceType: 'test',
    });
    const commandSentinel = 'RAW-COMMAND-SENTINEL-MUST-NOT-ENTER-MEMORY-QUERY';

    const created = await f.runtime.execution.create(f.scope, {
      objective: 'Build the package using the established local clean build path and avoid the stale lock',
      nodes: [{
        id: 'A',
        purpose: 'Build package with the clean local path',
        command: printCommand(commandSentinel),
        cwd: f.work,
      }],
    });
    expect(created.memoryPreSearch).toMatchObject({ status: 'healthy', blocked: false, inspectionRequired: true });
    expect(created.memoryPreSearch?.priorFailures.map((hit) => hit.memoryId)).toContain(priorFailure.memoryId);
    expect(created.memoryPreSearch?.relatedDecisions.map((hit) => hit.memoryId)).toContain(decision.memoryId);
    expect(created.memoryPreSearch?.query).not.toContain(commandSentinel);

    const started = await f.runtime.execution.start(f.scope, created.runId);
    expect(started.memoryPreSearch).toMatchObject({ status: 'healthy', blocked: false, inspectionRequired: true });
    expect(started.memoryPreSearch?.query).not.toContain(commandSentinel);
    await eventually(async () => {
      expect((await f.runtime.execution.status(f.scope, created.runId))?.state).toBe('completed');
    });
  });

  it('fails open with explicit degraded status when memory search is unavailable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-core-execution-memory-degraded-'));
    roots.push(root);
    const work = path.join(root, 'work');
    await mkdir(work, { recursive: true });
    const defaults = loadConfig({}, root);
    const memorySearch = new ExecutionMemoryPreSearch({
      config: {
        enabled: true,
        enforceHardGuardrails: true,
        recallItemBudget: 24,
        recallCharacterBudget: 12_000,
      },
      search: async () => { throw new Error('synthetic memory outage'); },
      listOpenConflicts: async () => [],
    });
    const service = new ExecutionService(
      {
        ...defaults.execution,
        enabled: true,
        dbPath: path.join(root, 'runtime', 'execution.sqlite'),
        logRoot: path.join(root, 'runtime', 'runs'),
      },
      new WorkspacePolicy([root]),
      { memorySearch },
    );
    services.push(service);
    await service.open();
    const scope = { principalId: 'principal-degraded', projectId: root };

    const created = await service.create(scope, {
      objective: 'Continue execution despite unavailable memory search',
      nodes: [{ id: 'A', purpose: 'Run harmless proof', command: printCommand('ok'), cwd: work }],
    });
    expect(created.memoryPreSearch).toMatchObject({
      status: 'degraded',
      blocked: false,
      degradedReason: 'synthetic memory outage',
    });
    const started = await service.start(scope, created.runId);
    expect(started.memoryPreSearch).toMatchObject({ status: 'degraded', blocked: false });
    await eventually(async () => expect((await service.status(scope, created.runId))?.state).toBe('completed'));
  });

  const performanceGate = process.env.AGENT_CORE_PERFORMANCE_GATES === '1' ? it : it.skip;
  performanceGate('keeps real execution pre-search below 500 ms p95', async () => {
    const f = await fixture('performance');
    for (let index = 0; index < 50; index += 1) {
      await f.runtime.memory.commit({
        scope: f.scope,
        canonicalKey: `observation.package.build.${index}`,
        kind: 'observation',
        value: `Package build observation ${index} uses the local clean build path and deterministic verification.`,
        sourceType: 'performance-fixture',
      });
    }
    const preSearch = new ExecutionMemoryPreSearch(f.runtime.memory);
    const operation = () => preSearch.run(
      f.scope,
      'Build package with local clean build verification',
      [{ id: 'A', purpose: 'Compile and verify package build' }],
    );
    for (let index = 0; index < 3; index += 1) await operation();
    const samples: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const startedAt = performance.now();
      await operation();
      samples.push(performance.now() - startedAt);
    }
    expect(percentile(samples, 0.95)).toBeLessThan(500);
  }, 30_000);
});
