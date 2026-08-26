import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
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

const roots: string[] = [];
const servers: Server[] = [];
const runtimes: RuntimeServices[] = [];

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-core-github-mcp-'));
  roots.push(root);
  const keyStore = new FileKeyStore(path.join(root, 'data'));
  const created = await keyStore.create('github-mcp-client');
  const defaults = loadConfig({}, root);
  const runtime = createRuntimeServices(
    [root],
    path.join(root, 'capabilities'),
    undefined,
    { ...defaults.memory, enabled: false },
    { ...defaults.execution, enabled: false },
    defaults.github,
  );
  runtimes.push(runtime);
  const app = createHttpHandler({
    keyStore,
    auditLogger: new FileAuditLogger(path.join(root, 'logs')),
    mcpHandler: createMcpHttpHandler(runtime),
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { root, created, runtime, baseUrl: `http://127.0.0.1:${port}` };
}

async function call(baseUrl: string, key: string, name: string, args: Record<string, unknown> = {}) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } }),
  });
  return await response.json() as Record<string, any>;
}

function parsed(json: Record<string, any>) {
  return JSON.parse(json.result.content[0].text) as Record<string, any>;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(runtimes.splice(0).map(async (runtime) => {
    await runtime.execution.close().catch(() => undefined);
    await runtime.memory.close().catch(() => undefined);
  }));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Native GitHub MCP tools', () => {
  it('reports local github status without reading credentials or requiring a route', async () => {
    const { baseUrl, created } = await setup();
    const json = await call(baseUrl, created.key, 'github_status');
    const result = parsed(json);
    expect(result).toMatchObject({
      enabled: true,
      apiBaseUrl: 'https://api.github.com',
      apiVersion: '2026-03-10',
      githubTokenConfigured: false,
      packagesTokenConfigured: false,
    });
    expect(result).toHaveProperty('gitAvailable');
    expect(JSON.stringify(result)).not.toMatch(/tokenValue|tokenLength|tokenHash/i);
  });

  it('rejects a github operation with an unknown route before credential or network work', async () => {
    const { baseUrl, created } = await setup();
    const json = await call(baseUrl, created.key, 'github_repo', {
      operation: 'get', owner: 'octo', repo: 'demo', routeContextId: randomUUID(),
    });
    expect(json.result.isError).toBe(true);
    expect(parsed(json).error.code).toBe('ROUTE_NOT_FOUND');
  });

  it('routes a read-only github repository task to github_repo and reaches the credential boundary', async () => {
    const { baseUrl, created } = await setup();
    const routed = await call(baseUrl, created.key, 'capability_route', {
      task: 'Get GitHub repository metadata for octo/demo',
    });
    const route = parsed(routed);
    expect(route.allowedTools).toContain('github_repo');
    const json = await call(baseUrl, created.key, 'github_repo', {
      operation: 'get', owner: 'octo', repo: 'demo', routeContextId: route.routeContextId,
    });
    expect(json.result.isError).toBe(true);
    expect(parsed(json).error.code).toBe('GITHUB_CREDENTIAL_MISSING');
  });

  it('does not allow a mutation through an atomic read-only route', async () => {
    const { baseUrl, created } = await setup();
    const routed = await call(baseUrl, created.key, 'capability_route', {
      task: 'Get GitHub repository metadata for octo/demo',
    });
    const route = parsed(routed);
    const json = await call(baseUrl, created.key, 'github_repo', {
      operation: 'create', repo: 'should-not-run', routeContextId: route.routeContextId,
    });
    expect(json.result.isError).toBe(true);
    expect(parsed(json).error.code).toBe('ROUTE_TOOL_NOT_ALLOWED');
  });

  it('requires destructive confirmation for generic non-GET github_api before a credential read', async () => {
    const { baseUrl, created } = await setup();
    const routed = await call(baseUrl, created.key, 'capability_route', {
      task: 'Update GitHub repository settings',
    });
    const route = parsed(routed);
    const json = await call(baseUrl, created.key, 'github_api', {
      method: 'PATCH', endpoint: '/repos/octo/demo', body: { description: 'x' }, routeContextId: route.routeContextId,
    });
    expect(json.result.isError).toBe(true);
    expect(parsed(json).error.code).toBe('GITHUB_DESTRUCTIVE_CONFIRMATION_REQUIRED');
  });
});
