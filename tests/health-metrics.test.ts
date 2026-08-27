import { describe, expect, it } from 'vitest';
import { RuntimeHealthMetrics } from '../src/runtime/health-metrics.js';
import { RuntimeMetricRegistry } from '../src/runtime/metric-window.js';
import { RouteContextStore } from '../src/runtime/route-context-store.js';
import { loadConfig } from '../src/config.js';
import { createRuntimeServices } from '../src/runtime/services.js';
import { startAgentCoreService } from '../src/index.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { printCommand } from './helpers/platform-command.js';
import { FileKeyStore } from '../src/auth/key-store.js';
import { FileAuditLogger } from '../src/logging/audit-log.js';
import { createHttpHandler } from '../src/http/app.js';
import { createMcpHttpHandler } from '../src/mcp/handler.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RoutePlan } from '../src/capabilities/route-types.js';

function routePlan(): RoutePlan {
  return {
    tier: 'atomic', mode: 'atomic_direct', domain: 'general', confidence: 1, risk: 'low',
    recommendedCapabilities: [], requiredSkillLoads: [], allowedTools: ['read_file'],
    verification: { required: false, suggestedTools: [] }, reasonCodes: ['fixture'],
  };
}

describe('bounded runtime observability', () => {
  it('keeps bounded rolling samples while preserving total count and deterministic percentiles', () => {
    const metrics = new RuntimeMetricRegistry({ sampleCapacity: 5, now: () => 10_000 });
    for (let value = 1; value <= 10; value += 1) metrics.observe('memory.search.duration_ms', value);
    metrics.failure('memory.search.duration_ms', 'MEMORY_TEST_FAILURE');

    expect(metrics.metric('memory.search.duration_ms')).toEqual({
      count: 10,
      windowSize: 5,
      last: 10,
      p50: 8,
      p95: 10,
      p99: 10,
      max: 10,
      lastFailureCode: 'MEMORY_TEST_FAILURE',
      lastFailureAt: 10_000,
    });
  });

  it('tracks route lifecycle counters without exposing route contents', () => {
    let now = Date.parse('2026-08-27T00:00:00.000Z');
    const metrics = new RuntimeMetricRegistry({ now: () => now });
    const store = new RouteContextStore({ now: () => now, ttlMs: 100, metrics });
    const first = store.create('principal-a', routePlan());
    store.create('principal-a', routePlan());
    expect(store.metrics()).toMatchObject({ totalRoutes: 2, activeContexts: 2, rejectedRoutes: 0, expiredContexts: 0 });

    expect(() => store.validate(first.routeContextId, 'principal-b', 'read_file')).toThrow();
    expect(store.metrics().rejectedRoutes).toBe(1);
    now += 101;
    expect(store.get(first.routeContextId)).toBeNull();
    expect(store.metrics()).toMatchObject({ activeContexts: 0, expiredContexts: 2 });
  });

  it('caches and single-flights GitHub API health probes while distinguishing configured from valid credentials', async () => {
    let now = 1_000;
    let calls = 0;
    let resolveProbe!: () => void;
    const gate = new Promise<void>((resolve) => { resolveProbe = resolve; });
    const runtime = {
      metrics: new RuntimeMetricRegistry({ now: () => now }),
      memory: {
        config: { enabled: true }, currentState: 'healthy',
        status: async () => ({ enabled: true, healthy: true, counts: { active_items: 7, db_bytes: 100 }, integrity: 'ok' }),
      },
      execution: {
        config: { enabled: true }, currentState: 'healthy',
        health: async () => ({ enabled: true, healthy: true, activeRuns: 1, queuedSync: 0, integrity: 'ok' }),
        store: { systemCounts: async () => ({ activeRuns: 1, queuedSync: 0, queuedNodes: 2, runningNodes: 1 }) },
      },
      github: {
        config: { enabled: true },
        status: async () => ({ githubTokenConfigured: true, packagesTokenConfigured: false, gitAvailable: true }),
        apiRequest: async () => { calls += 1; await gate; return { status: 200, data: { login: 'safe-user' } }; },
      },
      routes: { metrics: () => ({ totalRoutes: 3, activeContexts: 1, rejectedRoutes: 0, expiredContexts: 2 }) },
      capabilities: { coverage: () => ({ nativeReady: 2 }) },
    } as any;
    const provider = new RuntimeHealthMetrics(runtime, { now: () => now, githubProbeTtlMs: 5000 });

    const firstPromise = provider.getMetrics();
    const secondPromise = provider.getMetrics();
    await Promise.resolve();
    expect(calls).toBe(1);
    resolveProbe();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(second.github).toEqual(first.github);
    expect(first.github).toMatchObject({ apiHealth: 'green', credentialStatus: 'valid' });
    expect(first.overallHealth).toBe('healthy');

    await provider.getMetrics();
    expect(calls).toBe(1);
    now += 5001;
    await provider.getMetrics();
    expect(calls).toBe(2);
  });

  it('classifies required local persistence failure as critical and optional GitHub failure as degraded', async () => {
    const base = {
      metrics: new RuntimeMetricRegistry(),
      execution: {
        config: { enabled: true }, currentState: 'healthy',
        health: async () => ({ enabled: true, healthy: true, activeRuns: 0, queuedSync: 0, integrity: 'ok' }),
        store: { systemCounts: async () => ({ activeRuns: 0, queuedSync: 0, queuedNodes: 0, runningNodes: 0 }) },
      },
      routes: { metrics: () => ({ totalRoutes: 0, activeContexts: 0, rejectedRoutes: 0, expiredContexts: 0 }) },
      capabilities: { coverage: () => ({ nativeReady: 0 }) },
    } as any;

    const critical = new RuntimeHealthMetrics({
      ...base,
      memory: { config: { enabled: true }, currentState: 'degraded', status: async () => ({ enabled: true, healthy: false, counts: {}, integrity: 'corrupt' }) },
      github: { config: { enabled: false }, status: async () => ({ githubTokenConfigured: false }), apiRequest: async () => ({ status: 200 }) },
    } as any);
    expect((await critical.getMetrics()).overallHealth).toBe('critical');

    const degraded = new RuntimeHealthMetrics({
      ...base,
      memory: { config: { enabled: true }, currentState: 'healthy', status: async () => ({ enabled: true, healthy: true, counts: {}, integrity: 'ok' }) },
      github: { config: { enabled: true }, status: async () => ({ githubTokenConfigured: false }), apiRequest: async () => ({ status: 200 }) },
    } as any);
    const degradedMetrics = await degraded.getMetrics();
    expect(degradedMetrics.github).toMatchObject({ credentialStatus: 'missing', apiHealth: 'red' });
    expect(degradedMetrics.overallHealth).toBe('degraded');
  });

  it('instruments real memory, DAG, dispatch, and wake operations through the shared runtime registry', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-core-health-instrumentation-'));
    const defaults = loadConfig({}, root);
    const runtime = createRuntimeServices(
      [root], path.join(root, 'capabilities'), undefined,
      { ...defaults.memory, enabled: true, dbPath: path.join(root, 'runtime', 'memory.sqlite') },
      { ...defaults.execution, enabled: true, dbPath: path.join(root, 'runtime', 'execution.sqlite'), logRoot: path.join(root, 'runtime', 'runs') },
      { ...defaults.github, enabled: false },
    );
    try {
      await runtime.execution.open();
      await runtime.memory.search({ scope: { principalId: 'metrics-principal', projectId: root }, query: 'no matching memory' });
      expect(runtime.metrics.metric('memory.search.duration_ms').count).toBe(1);

      const created = await runtime.execution.create({ principalId: 'metrics-principal', projectId: root }, {
        objective: 'metrics fixture',
        nodes: [{ id: 'A', purpose: 'A', command: printCommand('ok'), cwd: root }],
      });
      expect(runtime.metrics.metric('execution.dag_validation.duration_ms').count).toBe(1);
      await runtime.execution.start({ principalId: 'metrics-principal', projectId: root }, created.runId);
      expect(runtime.metrics.metric('execution.dispatch.duration_ms').count).toBeGreaterThanOrEqual(1);
      await runtime.execution.wait(
        { principalId: 'metrics-principal', projectId: root }, created.runId, created.lastEventSequence,
        { eventTypes: ['run.completed'] }, 5_000,
      );
      expect(runtime.metrics.metric('execution.wake_delivery.duration_ms').count).toBeGreaterThanOrEqual(1);
    } finally {
      await runtime.execution.close().catch(() => undefined);
      await runtime.memory.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  it('serves detailed metrics separately from lightweight readiness without exposing credential paths', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-core-health-http-'));
    const config = loadConfig({}, root);
    config.port = 0;
    config.allowedRoots = [root];
    config.dataDir = path.join(root, 'data');
    config.logDir = path.join(root, 'logs');
    config.capabilityDir = path.join(root, 'capabilities');
    config.memory = { ...config.memory, dbPath: path.join(root, 'runtime', 'memory.sqlite') };
    config.execution = { ...config.execution, dbPath: path.join(root, 'runtime', 'execution.sqlite'), logRoot: path.join(root, 'runtime', 'runs') };
    config.github = { ...config.github, enabled: false };
    const service = await startAgentCoreService(config);
    try {
      const readiness = await (await fetch(`http://${service.host}:${service.port}/health`)).json() as any;
      expect(readiness.status).toBe('ok');
      expect(readiness.metrics).toBeUndefined();

      const response = await fetch(`http://${service.host}:${service.port}/health/metrics`);
      expect(response.status).toBe(200);
      const metrics = await response.json() as any;
      expect(metrics).toMatchObject({ overallHealth: 'healthy', memory: { healthy: true }, execution: { healthy: true } });
      const serialized = JSON.stringify(metrics);
      expect(serialized).not.toContain('secrets/github');
      expect(serialized).not.toContain('gh-token');
      expect(serialized).not.toContain('packages-token');
    } finally {
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  });


  it('registers a read-only agent_core_health_metrics MCP surface backed by the same provider', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-core-health-mcp-'));
    const defaults = loadConfig({}, root);
    const runtime = createRuntimeServices(
      [root], path.join(root, 'capabilities'), undefined,
      { ...defaults.memory, enabled: false },
      { ...defaults.execution, enabled: true, dbPath: path.join(root, 'execution.sqlite'), logRoot: path.join(root, 'runs') },
      { ...defaults.github, enabled: false },
    );
    await runtime.execution.open();
    const keyStore = new FileKeyStore(path.join(root, 'data'));
    const principal = await keyStore.create('health-metrics-principal');
    const server = createServer(createHttpHandler({
      keyStore,
      auditLogger: new FileAuditLogger(path.join(root, 'logs')),
      mcpHandler: createMcpHttpHandler(runtime),
    }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const listed = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${principal.key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }).then((r) => r.json()) as any;
      const tool = listed.result.tools.find((entry: any) => entry.name === 'agent_core_health_metrics');
      expect(tool).toBeTruthy();
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });

      const called = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${principal.key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'agent_core_health_metrics', arguments: {} } }),
      }).then((r) => r.json()) as any;
      const body = JSON.parse(called.result.content[0].text);
      expect(body).toMatchObject({ execution: { healthy: true }, github: { enabled: false } });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await runtime.execution.close().catch(() => undefined);
      await runtime.memory.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

});
