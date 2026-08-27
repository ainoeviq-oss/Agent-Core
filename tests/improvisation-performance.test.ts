import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionArtifactManager } from '../src/execution/artifact-manager.js';
import { parseExecutionOutput } from '../src/execution/output-parser.js';
import { ExecutionStore } from '../src/execution/store.js';
import { WorkflowAdvisor } from '../src/mcp/workflow-advisor.js';
import { RuntimeHealthMetrics } from '../src/runtime/health-metrics.js';
import { RuntimeMetricRegistry } from '../src/runtime/metric-window.js';
import { WorkspacePolicy } from '../src/runtime/workspace.js';

const roots: string[] = [];
const stores: ExecutionStore[] = [];

function percentile(values: number[], fraction: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1));
  return ordered[index] ?? 0;
}

async function timings(operation: () => void | Promise<void>, samples = 30, warmup = 5): Promise<number[]> {
  for (let index = 0; index < warmup; index += 1) await operation();
  const values: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    await operation();
    values.push(performance.now() - started);
  }
  return values;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close().catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  })));
});

const performanceGate = process.env.AGENT_CORE_PERFORMANCE_GATES === '1' ? it : it.skip;

describe('Agent Core improvisation performance gates', () => {
  performanceGate('renders health metrics below 50 ms p95 without a live GitHub probe', async () => {
    const registry = new RuntimeMetricRegistry({ sampleCapacity: 128 });
    const runtime = {
      metrics: registry,
      memory: {
        config: { enabled: false },
        currentState: 'disabled',
        status: async () => ({ enabled: false, healthy: true, counts: { active_items: 0, db_bytes: 0 }, integrity: 'disabled' }),
      },
      execution: {
        config: { enabled: true },
        currentState: 'healthy',
        health: async () => ({ enabled: true, healthy: true, activeRuns: 0, queuedSync: 0, integrity: 'ok' }),
        store: { systemCounts: async () => ({ activeRuns: 0, queuedSync: 0, queuedNodes: 0, runningNodes: 0 }) },
      },
      github: {
        config: { enabled: false },
        status: async () => ({ githubTokenConfigured: false }),
        apiRequest: async () => ({ status: 200 }),
      },
      routes: { metrics: () => ({ totalRoutes: 0, activeContexts: 0, rejectedRoutes: 0, expiredContexts: 0 }) },
      capabilities: { coverage: () => ({ nativeReady: 0 }) },
    } as any;
    const health = new RuntimeHealthMetrics(runtime);
    const measured = await timings(async () => { void await health.getMetrics(); }, 40, 5);
    expect(percentile(measured, 0.95)).toBeLessThan(50);
  });

  performanceGate('parses a bounded 128 KiB execution output below 25 ms p95', async () => {
    const prefix = 'Tests 42 passed 1 skipped\nPERF parse_ms=1.25\nwarning synthetic bounded warning\n';
    const stdout = (prefix + 'x'.repeat(128 * 1024)).slice(0, 128 * 1024);
    const input = {
      nodeId: 'A',
      attemptNo: 1,
      stdout,
      stderr: '',
      exitCode: 0,
      stdoutSha256: 'a'.repeat(64),
      stderrSha256: 'b'.repeat(64),
      stdoutBytes: 128 * 1024,
      stderrBytes: 0,
    };
    const first = parseExecutionOutput(input);
    expect(first.raw.stdoutBytes).toBe(128 * 1024);
    expect(first.structured.performanceMetrics).toEqual({ parse_ms: 1.25 });
    const measured = await timings(() => { void parseExecutionOutput(input); }, 40, 5);
    expect(percentile(measured, 0.95)).toBeLessThan(25);
  });

  performanceGate('looks up a SHA-256 through a 1000-row artifact index below 50 ms p95', async () => {
    const root = await mkdtemp(path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), 'agent-core-improvisation-artifact-perf-'));
    roots.push(root);
    const store = new ExecutionStore();
    stores.push(store);
    await store.open({ dbPath: path.join(root, 'execution.sqlite') });
    const scope = { principalId: 'artifact-perf-principal', projectId: root };
    const now = Date.now();

    for (let offset = 0; offset < 1000; offset += 100) {
      const operations: Array<{ kind: 'run'; sql: string; params: unknown[] }> = [];
      for (let index = offset; index < offset + 100; index += 1) {
        const runId = `run-${String(index).padStart(4, '0')}`;
        const hash = index.toString(16).padStart(64, '0');
        operations.push({
          kind: 'run',
          sql: `INSERT INTO execution_runs(id,principal_id,project_id,state,objective,max_concurrency,metadata_json,created_at,finished_at,updated_at)
                VALUES (?,?,?,'completed',?,1,'{}',?,?,?)`,
          params: [runId, scope.principalId, scope.projectId, `artifact perf ${index}`, now + index, now + index, now + index],
        });
        operations.push({
          kind: 'run',
          sql: `INSERT INTO execution_nodes(run_id,node_id,purpose,command_text,cwd,state,timeout_ms,continue_on_failure,expected_artifacts_json,attempt_count,created_at,updated_at,finished_at)
                VALUES (?,'A','artifact perf','noop',?,'succeeded',1000,0,'[]',1,?,?,?)`,
          params: [runId, root, now + index, now + index, now + index],
        });
        operations.push({
          kind: 'run',
          sql: `INSERT INTO execution_artifacts(artifact_id,run_id,node_id,attempt_no,path,artifact_type,verification,sha256,size,modified_at,source_result_ref,metadata_json,created_at)
                VALUES (?,?,'A',1,?,'build','verified',?,1,?,'result.json','{}',?)`,
          params: [`artifact-${String(index).padStart(4, '0')}`, runId, path.join(root, `artifact-${index}.bin`), hash, now + index, now + index],
        });
      }
      await store.client.transaction(operations);
    }

    const artifacts = new ExecutionArtifactManager(store, new WorkspacePolicy([root]));
    const targetHash = (500).toString(16).padStart(64, '0');
    expect(await artifacts.findByHash(scope, targetHash)).toHaveLength(1);
    const measured = await timings(async () => { void await artifacts.findByHash(scope, targetHash); }, 40, 5);
    expect(percentile(measured, 0.95)).toBeLessThan(50);
  }, 30_000);

  performanceGate('analyzes a deterministic 128-node workflow below 50 ms p95', async () => {
    const nodes = Array.from({ length: 128 }, (_, index) => ({
      runId: 'run-perf',
      nodeId: `N${String(index).padStart(3, '0')}`,
      purpose: `node ${index}`,
      command: 'noop',
      cwd: '/project',
      state: 'queued',
      timeoutMs: 1000,
      continueOnFailure: false,
      expectedArtifacts: [],
      attemptCount: 0,
      dependsOn: [],
      createdAt: 1,
      updatedAt: 1,
    }));
    const evidenceNodes = nodes.map((node) => ({
      nodeId: node.nodeId,
      attemptNo: null,
      resultVersion: null,
      processState: 'queued',
      evidenceState: 'pending',
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutSha256: null,
      stderrSha256: null,
      artifacts: [],
    }));
    const view = {
      runId: '11111111-1111-4111-8111-111111111111',
      state: 'planned',
      objective: '128-node workflow advisor performance gate',
      maxConcurrency: 8,
      lastEventSequence: 128,
      principalId: 'principal',
      projectId: '/project',
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
      nodes,
      evidence: { verification: 'pending', nodes: evidenceNodes },
    } as any;
    const runtime = {
      execution: {
        config: { enabled: true },
        currentState: 'healthy',
        artifacts: { findReusable: async () => ({ found: false, advisoryOnly: true }) },
      },
      memory: { config: { enabled: true }, currentState: 'healthy' },
    } as any;
    const advisor = new WorkflowAdvisor(runtime);
    const context = {
      scope: { principalId: 'principal', projectId: '/project' },
      routeContextId: 'route-perf',
      availableTools: ['execution_start'],
      includeCacheValidation: false,
    };
    const first = await advisor.analyzeRun(view, context);
    expect(first[0]?.sourceNodeIds).toHaveLength(128);
    const measured = await timings(async () => { void await advisor.analyzeRun(view, context); }, 40, 5);
    expect(percentile(measured, 0.95)).toBeLessThan(50);
  });

  performanceGate('keeps 100000 metric observations bounded to 128 samples within 500 ms', () => {
    const metrics = new RuntimeMetricRegistry({ sampleCapacity: 128 });
    const started = performance.now();
    for (let index = 0; index < 100_000; index += 1) metrics.observe('perf.metric', index % 1000);
    const elapsed = performance.now() - started;
    const snapshot = metrics.metric('perf.metric');
    expect(snapshot.count).toBe(100_000);
    expect(snapshot.windowSize).toBe(128);
    expect(elapsed).toBeLessThan(500);
  });
});
