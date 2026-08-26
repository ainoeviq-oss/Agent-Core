import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { FileKeyStore } from '../src/auth/key-store.js';
import { loadConfig } from '../src/config.js';
import { createHttpHandler } from '../src/http/app.js';
import { FileAuditLogger } from '../src/logging/audit-log.js';
import { createMcpHttpHandler } from '../src/mcp/handler.js';
import { createRuntimeServices, type RuntimeServices } from '../src/runtime/services.js';
import { printCommand } from './helpers/platform-command.js';

const tempRoots: string[] = [];
const servers: Server[] = [];
const runtimes: RuntimeServices[] = [];

async function fixture() {
  const container = await mkdtemp(path.join(os.tmpdir(), 'agent-core-project-scope-'));
  tempRoots.push(container);
  const projectA = path.join(container, 'project-a');
  const projectB = path.join(container, 'project-b');
  await Promise.all([mkdir(projectA), mkdir(projectB)]);
  const defaults = loadConfig({}, projectA);
  const runtime = createRuntimeServices(
    [projectA, projectB],
    path.join(container, 'capabilities'),
    undefined,
    { ...defaults.memory, enabled: true, dbPath: path.join(container, 'runtime', 'memory.sqlite') },
    {
      ...defaults.execution,
      enabled: true,
      dbPath: path.join(container, 'runtime', 'execution.sqlite'),
      logRoot: path.join(container, 'runtime', 'runs'),
    },
  );
  await runtime.execution.open();
  runtimes.push(runtime);
  const keyStore = new FileKeyStore(path.join(container, 'data'));
  const principal = await keyStore.create('multi-root-principal');
  const server = createServer(createHttpHandler({
    keyStore,
    auditLogger: new FileAuditLogger(path.join(container, 'logs')),
    mcpHandler: createMcpHttpHandler(runtime),
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return {
    container,
    projectA,
    projectB,
    runtime,
    principal,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}

async function call(baseUrl: string, key: string, name: string, args: Record<string, unknown> = {}) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 998, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await response.json() as Record<string, any>;
  const text = raw.result?.content?.[0]?.text;
  let result: Record<string, any> = {};
  if (typeof text === 'string') {
    try { result = JSON.parse(text) as Record<string, any>; }
    catch { result = { text }; }
  }
  return { raw, result };
}

async function route(f: Awaited<ReturnType<typeof fixture>>, projectRoot: string, label: string) {
  const routed = await call(f.baseUrl, f.principal.key, 'capability_route', {
    task: `Work on ${label}`,
    context: `The exact project root is ${projectRoot}`,
    projectRoot,
  });
  expect(routed.raw.result?.isError).not.toBe(true);
  return routed.result;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(runtimes.splice(0).map(async (runtime) => {
    await runtime.execution.close().catch(() => undefined);
    await runtime.memory.close().catch(() => undefined);
  }));
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('route-bound project identity and cross-project isolation', () => {
  it('binds capability_route to an explicit project and exposes machine-readable inspection directives', async () => {
    const f = await fixture();
    const routed = await route(f, f.projectB, 'Project B');

    expect(routed.projectId).toBe(f.projectB);
    expect(f.runtime.routes.get(routed.routeContextId)?.projectId).toBe(f.projectB);
    expect(routed.memoryDirective).toMatchObject({
      inspectionRequired: expect.any(Boolean),
      hasBlockingGuardrails: expect.any(Boolean),
      hasPriorFailures: expect.any(Boolean),
      hasRelatedDecisions: expect.any(Boolean),
    });
    expect(routed.continuityDirective).toMatchObject({
      inspectionRequired: true,
      ambiguousResume: false,
    });
    expect(routed.continuitySnapshot.activeTasks.every((task: any) => task.projectId === f.projectB)).toBe(true);
  });

  it('infers a unique project from bounded context path evidence and fails closed when no project is uniquely identified', async () => {
    const f = await fixture();
    const inferred = await call(f.baseUrl, f.principal.key, 'capability_route', {
      task: 'Inspect the requested project',
      context: `Only inspect files under ${f.projectB}`,
    });
    expect(inferred.raw.result?.isError).not.toBe(true);
    expect(inferred.result.projectId).toBe(f.projectB);

    const ambiguous = await call(f.baseUrl, f.principal.key, 'capability_route', {
      task: 'Inspect the project',
    });
    expect(ambiguous.raw.result?.isError).toBe(true);
    expect(ambiguous.result.error?.code).toBe('WORKSPACE_PROJECT_AMBIGUOUS');
  });

  it('prevents a route for project B from operating on project A even though both roots are globally allowed', async () => {
    const f = await fixture();
    const routeB = await route(f, f.projectB, 'Project B');
    const allowedPath = path.join(f.projectB, 'allowed.txt');
    const deniedPath = path.join(f.projectA, 'denied.txt');

    const allowed = await call(f.baseUrl, f.principal.key, 'write_file', {
      routeContextId: routeB.routeContextId,
      path: allowedPath,
      content: 'project-b-only',
    });
    expect(allowed.raw.result?.isError).not.toBe(true);
    await expect(access(allowedPath)).resolves.toBeUndefined();

    const denied = await call(f.baseUrl, f.principal.key, 'write_file', {
      routeContextId: routeB.routeContextId,
      path: deniedPath,
      content: 'must-not-cross-project',
    });
    expect(denied.raw.result?.isError).toBe(true);
    expect(denied.result.error?.code).toBe('ROUTE_PROJECT_MISMATCH');
    await expect(access(deniedPath)).rejects.toThrow();

    const deniedArtifact = await call(f.baseUrl, f.principal.key, 'execution_create', {
      routeContextId: routeB.routeContextId,
      objective: 'Cross-project artifact must be rejected',
      nodes: [{
        id: 'A',
        purpose: 'Attempt cross-project evidence declaration',
        command: printCommand('ok\n'),
        cwd: f.projectB,
        expectedArtifacts: [{ path: path.join(f.projectA, 'forbidden.txt'), kind: 'file', required: true }],
      }],
    });
    expect(deniedArtifact.raw.result?.isError).toBe(true);
    expect(deniedArtifact.result.error?.code).toBe('ROUTE_PROJECT_MISMATCH');
  });

  it('uses the route project for memory and execution instead of workspace root zero', async () => {
    const f = await fixture();
    const routeA = await route(f, f.projectA, 'Project A');
    const routeB = await route(f, f.projectB, 'Project B');

    const committed = await call(f.baseUrl, f.principal.key, 'memory_commit', {
      routeContextId: routeB.routeContextId,
      canonicalKey: 'project-b.fact',
      kind: 'fact',
      value: 'Only Project B may recall this fact.',
      sourceType: 'test',
    });
    expect(committed.raw.result?.isError).not.toBe(true);

    const recallB = await call(f.baseUrl, f.principal.key, 'memory_search', {
      routeContextId: routeB.routeContextId,
      query: 'Project B recall fact',
      limit: 10,
    });
    expect(recallB.result.hits.map((hit: any) => hit.canonicalKey)).toContain('project-b.fact');

    const recallA = await call(f.baseUrl, f.principal.key, 'memory_search', {
      routeContextId: routeA.routeContextId,
      query: 'Project B recall fact',
      limit: 10,
    });
    expect(recallA.result.hits.map((hit: any) => hit.canonicalKey)).not.toContain('project-b.fact');

    const created = await call(f.baseUrl, f.principal.key, 'execution_create', {
      routeContextId: routeB.routeContextId,
      objective: 'Project B execution',
      nodes: [{ id: 'B', purpose: 'B', command: printCommand('B\n'), cwd: f.projectB }],
    });
    expect(created.raw.result?.isError).not.toBe(true);
    expect(await f.runtime.execution.status({ principalId: f.principal.metadata.id, projectId: f.projectB }, created.result.runId))
      .not.toBeNull();
    expect(await f.runtime.execution.status({ principalId: f.principal.metadata.id, projectId: f.projectA }, created.result.runId))
      .toBeNull();

    const wrongProjectRead = await call(f.baseUrl, f.principal.key, 'execution_status', {
      routeContextId: routeA.routeContextId,
      runId: created.result.runId,
    });
    expect(wrongProjectRead.raw.result?.isError).toBe(true);
    expect(wrongProjectRead.result.error?.code).toBe('EXECUTION_RUN_NOT_FOUND');
  });
});
