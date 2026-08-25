import { access, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { FileKeyStore } from '../src/auth/key-store.js';
import type { RoutePlan } from '../src/capabilities/route-types.js';
import { loadConfig } from '../src/config.js';
import { createHttpHandler } from '../src/http/app.js';
import { FileAuditLogger } from '../src/logging/audit-log.js';
import { createMcpHttpHandler } from '../src/mcp/handler.js';
import { AgentCoreRouteError, RouteContextStore } from '../src/runtime/route-context-store.js';
import { createRuntimeServices } from '../src/runtime/services.js';

const roots: string[] = [];
const servers: Server[] = [];
const runtimes: Array<ReturnType<typeof createRuntimeServices>> = [];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function routePlan(): RoutePlan {
  return {
    tier: 'atomic', mode: 'atomic_direct', domain: 'general', confidence: 1, risk: 'low',
    recommendedCapabilities: [], requiredSkillLoads: [], allowedTools: ['write_file'],
    verification: { required: true, suggestedTools: ['read_file'] }, reasonCodes: ['fixture'],
  };
}

async function call(baseUrl: string, key: string, name: string, args: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 51, method: 'tools/call', params: { name, arguments: args } }),
  });
  return await response.json() as Record<string, any>;
}

function textBody(result: Record<string, any>) {
  return JSON.parse(result.result.content[0].text) as Record<string, any>;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.memory.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('memory-aware route context', () => {
  it('reserves route identity before routing and enforces only an explicitly enabled hard-memory snapshot', () => {
    const now = Date.parse('2026-08-25T01:00:00.000Z');
    const store = new RouteContextStore({ now: () => now, ttlMs: 60_000 });
    const reservation = store.reserve();
    expect(reservation.routeContextId).toMatch(UUID_RE);
    expect(reservation.createdAt).toBe('2026-08-25T01:00:00.000Z');
    expect(reservation.expiresAt).toBe('2026-08-25T01:01:00.000Z');

    const observed = store.create('principal-a', routePlan(), {
      reservation,
      memorySnapshot: {
        memoryContextId: 'memory-context-observe',
        memorySnapshotHash: 'a'.repeat(64),
        blockingGuardrailMemoryIds: ['guardrail-a'],
        enforceHardGuardrails: false,
      },
    });
    expect(observed.routeContextId).toBe(reservation.routeContextId);
    expect(observed.memorySnapshot?.memoryContextId).toBe('memory-context-observe');
    expect(store.validate(observed.routeContextId, 'principal-a', 'write_file').routeContextId)
      .toBe(observed.routeContextId);

    const blockedReservation = store.reserve();
    const blocked = store.create('principal-a', routePlan(), {
      reservation: blockedReservation,
      memorySnapshot: {
        memoryContextId: 'memory-context-enforced',
        memorySnapshotHash: 'b'.repeat(64),
        blockingGuardrailMemoryIds: ['guardrail-b'],
        enforceHardGuardrails: true,
      },
    });
    expect(() => store.validate(blocked.routeContextId, 'principal-a', 'write_file'))
      .toThrow(expect.objectContaining<Partial<AgentCoreRouteError>>({ code: 'ROUTE_MEMORY_GUARDRAIL_BLOCKED' }));
  });

  it('routes with memory evidence before execution and blocks a matching hard guardrail when enforcement is enabled', async () => {
    const root = await mkdtemp(path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), 'agent-core-memory-route-'));
    roots.push(root);
    const baseMemory = loadConfig({}, root).memory;
    const runtime = createRuntimeServices([root], path.join(root, 'capabilities'), undefined, {
      ...baseMemory,
      enabled: true,
      enforceHardGuardrails: true,
      dbPath: path.join(root, 'runtime', 'memory', 'routing.sqlite'),
    } as any);
    runtimes.push(runtime);
    const keyStore = new FileKeyStore(path.join(root, 'data'));
    const principal = await keyStore.create('memory-routing-principal');
    const scope = { principalId: principal.metadata.id, projectId: root };
    const guardrail = await runtime.memory.commit({
      scope,
      canonicalKey: 'guardrail.proof.file',
      kind: 'guardrail',
      value: `Do not create proof files inside ${root}.`,
      enforcement: 'hard',
      importance: 1,
      pinned: true,
      sourceType: 'test',
    });
    const priorFailure = await runtime.memory.commit({
      scope,
      canonicalKey: 'failure.proof.file',
      kind: 'failure',
      value: `Creating a proof file inside ${root} failed previously.`,
      importance: 0.9,
      sourceType: 'test',
    });

    const app = createHttpHandler({
      keyStore,
      auditLogger: new FileAuditLogger(path.join(root, 'logs')),
      mcpHandler: createMcpHttpHandler(runtime),
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const routed = await call(baseUrl, principal.key, 'capability_route', {
      task: `Create a proof file inside ${root}`,
      context: 'Use write_file and verify it afterwards.',
    });
    expect(routed.result.isError).not.toBe(true);
    const route = textBody(routed);
    expect(route.routeContextId).toMatch(UUID_RE);
    expect(route.memoryStatus).toBe('healthy');
    expect(route.memoryContextId).toMatch(UUID_RE);
    expect(route.memorySnapshotHash).toMatch(/^[a-f0-9]{64}$/);
    expect(route.memorySummary.map((item: any) => item.memoryId)).toContain(guardrail.memoryId);
    expect(route.blockingGuardrails.map((item: any) => item.memoryId)).toContain(guardrail.memoryId);
    expect(route.priorFailures.map((item: any) => item.memoryId)).toContain(priorFailure.memoryId);
    expect(route.memoryConfidence).toBeGreaterThan(0);

    const storedRoute = runtime.routes.get(route.routeContextId)!;
    expect(storedRoute.memorySnapshot).toMatchObject({
      memoryContextId: route.memoryContextId,
      memorySnapshotHash: route.memorySnapshotHash,
      blockingGuardrailMemoryIds: [guardrail.memoryId],
      enforceHardGuardrails: true,
    });
    const persistedMemoryContext = await runtime.memory.getContext(scope, route.memoryContextId);
    expect(persistedMemoryContext?.routeContextId).toBe(route.routeContextId);
    expect(persistedMemoryContext?.expiresAt).toBe(Date.parse(storedRoute.expiresAt));

    const target = path.join(root, 'proof.txt');
    const write = await call(baseUrl, principal.key, 'write_file', {
      path: target,
      content: 'must not be written',
      routeContextId: route.routeContextId,
    });
    expect(write.result.isError).toBe(true);
    expect(textBody(write).error.code).toBe('ROUTE_MEMORY_GUARDRAIL_BLOCKED');
    await expect(access(target)).rejects.toThrow();

    await runtime.memory.close();
  });

  it('invalidates persisted memory context at the same TTL as its reserved route', async () => {
    const root = await mkdtemp(path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), 'agent-core-memory-route-ttl-'));
    roots.push(root);
    const baseMemory = loadConfig({}, root).memory;
    const runtime = createRuntimeServices([root], path.join(root, 'capabilities'), undefined, {
      ...baseMemory,
      enabled: true,
      dbPath: path.join(root, 'runtime', 'memory', 'ttl.sqlite'),
    });
    runtimes.push(runtime);
    const routeStore = new RouteContextStore({ ttlMs: 500 });
    const reservation = routeStore.reserve();
    const scope = { principalId: 'principal-ttl', projectId: root };
    const preflight = await runtime.memory.preflight({
      scope,
      routeContextId: reservation.routeContextId,
      task: 'TTL fixture task',
      expiresAt: Date.parse(reservation.expiresAt),
    });
    routeStore.create(scope.principalId, routePlan(), {
      reservation,
      memorySnapshot: {
        memoryContextId: preflight.contextId,
        memorySnapshotHash: preflight.snapshotHash,
        blockingGuardrailMemoryIds: [],
        enforceHardGuardrails: false,
      },
    });
    expect(routeStore.get(reservation.routeContextId)).not.toBeNull();
    expect(await runtime.memory.getContext(scope, preflight.contextId)).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(routeStore.get(reservation.routeContextId)).toBeNull();
    expect(await runtime.memory.getContext(scope, preflight.contextId)).toBeNull();
  });

  it('keeps capability routing unchanged when DMF is enabled but has no relevant memory', async () => {
    const root = await mkdtemp(path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), 'agent-core-memory-route-empty-'));
    roots.push(root);
    const baseMemory = loadConfig({}, root).memory;
    const runtime = createRuntimeServices([root], path.join(root, 'capabilities'), undefined, {
      ...baseMemory,
      enabled: true,
      dbPath: path.join(root, 'runtime', 'memory', 'empty.sqlite'),
    });
    runtimes.push(runtime);
    const keyStore = new FileKeyStore(path.join(root, 'data'));
    const principal = await keyStore.create('empty-memory-principal');
    const app = createHttpHandler({
      keyStore,
      auditLogger: new FileAuditLogger(path.join(root, 'logs')),
      mcpHandler: createMcpHttpHandler(runtime),
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const routed = await call(baseUrl, principal.key, 'capability_route', { task: 'Create a small proof file' });
    const route = textBody(routed);
    expect(route).toMatchObject({ tier: 'atomic', mode: 'atomic_direct', memoryStatus: 'healthy' });
    expect(route.memoryContextId).toMatch(UUID_RE);
    expect(route.memorySummary).toEqual([]);
    expect(route.blockingGuardrails).toEqual([]);
    expect(route.memoryConfidence).toBe(0);
  });

  it('keeps disabled memory routing behavior unchanged and reports the disabled state explicitly', async () => {
    const root = await mkdtemp(path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), 'agent-core-memory-route-disabled-'));
    roots.push(root);
    const baseMemory = loadConfig({}, root).memory;
    const runtime = createRuntimeServices([root], path.join(root, 'capabilities'), undefined, {
      ...baseMemory,
      enabled: false,
    });
    runtimes.push(runtime);
    const keyStore = new FileKeyStore(path.join(root, 'data'));
    const principal = await keyStore.create('disabled-memory-principal');
    const app = createHttpHandler({
      keyStore,
      auditLogger: new FileAuditLogger(path.join(root, 'logs')),
      mcpHandler: createMcpHttpHandler(runtime),
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const routed = await call(baseUrl, principal.key, 'capability_route', { task: 'Create a small proof file' });
    const route = textBody(routed);
    expect(route).toMatchObject({ tier: 'atomic', mode: 'atomic_direct', memoryStatus: 'disabled' });
    expect(route.memoryContextId).toBeNull();
    expect(route.memorySummary).toEqual([]);
    expect(route.blockingGuardrails).toEqual([]);
    expect(route.openConflicts).toEqual([]);
    expect(route.priorFailures).toEqual([]);
    expect(route.relatedDecisions).toEqual([]);
    expect(route.memoryConfidence).toBe(0);
  });
});
