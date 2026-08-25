import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { FileKeyStore } from '../src/auth/key-store.js';
import { loadConfig } from '../src/config.js';
import { createHttpHandler } from '../src/http/app.js';
import { FileAuditLogger } from '../src/logging/audit-log.js';
import { createMcpHttpHandler } from '../src/mcp/handler.js';
import { createRuntimeServices } from '../src/runtime/services.js';

const roots: string[] = [];
const servers: Server[] = [];
const GATED_TOOLS = [
  'list_directory', 'read_file', 'read_multiple_files', 'write_file', 'edit_file',
  'create_directory', 'move_file', 'get_file_info', 'search_files', 'execute_command',
  'start_process',
] as const;

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-core-int-'));
  roots.push(root);
  const keyStore = new FileKeyStore(path.join(root, 'data'));
  const created = await keyStore.create('integration-client');
  const baseMemory = loadConfig({}, root).memory;
  const runtime = createRuntimeServices([root], path.join(root, 'capabilities'), undefined, {
    ...baseMemory,
    enabled: false,
  });
  const app = createHttpHandler({
    keyStore,
    auditLogger: new FileAuditLogger(path.join(root, 'logs')),
    mcpHandler: createMcpHttpHandler(runtime),
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { root, baseUrl: `http://127.0.0.1:${port}`, created };
}

async function mcpRequest(baseUrl: string, key: string, body: unknown) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  });
  return { response, json: await response.json() as Record<string, any> };
}

async function call(baseUrl: string, key: string, name: string, args: Record<string, unknown> = {}) {
  return mcpRequest(baseUrl, key, {
    jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name, arguments: args },
  });
}
function parsed(result: Record<string, any>) {
  return JSON.parse(result.json.result.content[0].text) as Record<string, any>;
}

function routeErrorCode(result: Record<string, any>) {
  return parsed(result).error?.code as string | undefined;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Agent Core MCP integration', () => {
  it('initializes v0.5.0 with exactly 35 automatic-routing, memory, and continuity tools and schemas', async () => {
    const { baseUrl, created } = await setup();
    const initialize = await mcpRequest(baseUrl, created.key, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2025-11-25', capabilities: {},
        clientInfo: { name: 'agent-core-test', version: '1.0.0' },
      },
    });
    expect(initialize.response.status).toBe(200);
    expect(initialize.json.result.serverInfo).toMatchObject({
      name: 'agent-core', version: '0.5.0',
    });
    const listed = await mcpRequest(baseUrl, created.key, {
      jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
    });
    const tools = listed.json.result.tools as Array<Record<string, any>>;
    const names = tools.map((tool) => tool.name);
    expect(names).toHaveLength(35);
    for (const name of ['task_checkpoint', 'continuity_status', 'continuity_get_task', 'continuity_frontier']) {
      expect(names).toContain(name);
    }
    expect(names).toContain('capability_route');
    expect(names).not.toContain('capability_recommend');
    for (const name of GATED_TOOLS) {
      const tool = tools.find((entry) => entry.name === name)!;
      expect(tool.inputSchema?.required).toContain('routeContextId');
      expect(tool.description).toContain(
        'Obtain routeContextId from capability_route before using this tool.',
      );
    }
  });

  it('reports the automatic-routing stage and authenticated principal', async () => {
    const { baseUrl, created } = await setup();
    const status = await call(baseUrl, created.key, 'agent_core_status');
    expect(status.json.result.structuredContent).toMatchObject({
      service: 'agent-core', serverName: 'agent-core', version: '0.5.0',
      authentication: 'bearer-api-key',
      key: { id: created.metadata.id, name: 'integration-client' },
    });
    const capabilities = await call(baseUrl, created.key, 'agent_core_capabilities');
    expect(capabilities.json.result.structuredContent).toMatchObject({
      stage: 'v4-automatic-capability-routing',
      enabled: expect.arrayContaining([
        'routing.capability_route', 'routing.principal_bound_context',
        'routing.execution_gate', 'tool.capability_route', 'tool.write_file',
      ]),
    });
  });

  it('routes an atomic proof flow and rejects a bypass with no filesystem side effect', async () => {
    const { root, baseUrl, created } = await setup();
    const routed = await call(baseUrl, created.key, 'capability_route', {
      task: 'Create a small proof file', context: `Workspace root is ${root}`,
    });
    const route = parsed(routed);
    expect(route).toMatchObject({ mode: 'atomic_direct', requiredSkillLoads: [] });
    const routeContextId = route.routeContextId as string;

    const proof = path.join(root, 'route-proof.txt');
    const written = await call(baseUrl, created.key, 'write_file', {
      path: proof, content: 'Agent Core automatic routing works', routeContextId,
    });
    expect(written.json.result.isError).not.toBe(true);
    const read = await call(baseUrl, created.key, 'read_file', { path: proof, routeContextId });
    expect(read.json.result.content[0].text).toContain('Agent Core automatic routing works');

    const bypassPath = path.join(root, `bypass-${randomUUID()}.txt`);
    const bypass = await call(baseUrl, created.key, 'write_file', {
      path: bypassPath, content: 'must not exist', routeContextId: randomUUID(),
    });
    expect(bypass.json.result.isError).toBe(true);
    expect(routeErrorCode(bypass)).toBe('ROUTE_NOT_FOUND');
    await expect(access(bypassPath)).rejects.toThrow();
  });
});
