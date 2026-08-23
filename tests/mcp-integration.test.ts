import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { FileKeyStore } from '../src/auth/key-store.js';
import { createHttpHandler } from '../src/http/app.js';
import { FileAuditLogger } from '../src/logging/audit-log.js';
import { createMcpHttpHandler } from '../src/mcp/handler.js';
import { createRuntimeServices } from '../src/runtime/services.js';

const roots: string[] = [];
const servers: Server[] = [];

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-core-int-'));
  roots.push(root);
  const keyStore = new FileKeyStore(path.join(root, 'data'));
  const created = await keyStore.create('integration-client');
  const app = createHttpHandler({
    keyStore,
    auditLogger: new FileAuditLogger(path.join(root, 'logs')),
    mcpHandler: createMcpHttpHandler(createRuntimeServices([root])),
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { baseUrl: `http://127.0.0.1:${port}`, created };
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

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Agent Core MCP integration', () => {
  it('initializes as agent-core and exposes the hybrid operational and capability tools', async () => {
    const { baseUrl, created } = await setup();
    const initialize = await mcpRequest(baseUrl, created.key, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'agent-core-test', version: '1.0.0' },
      },
    });
    expect(initialize.response.status).toBe(200);
    expect(initialize.json.result.serverInfo).toMatchObject({
      name: 'agent-core',
      version: '0.4.0',
    });

    const listed = await mcpRequest(baseUrl, created.key, {
      jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
    });
    expect(listed.response.status).toBe(200);
    expect(listed.json.result.tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining([
      'agent_core_status', 'agent_core_capabilities', 'workspace_info', 'list_directory',
      'read_file', 'write_file', 'search_files', 'execute_command', 'start_process',
      'read_process_output', 'stop_process', 'list_processes',
    ]));
  });

  it('reports hybrid status and capabilities with deterministic structured results', async () => {
    const { baseUrl, created } = await setup();
    const status = await mcpRequest(baseUrl, created.key, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'agent_core_status', arguments: {} },
    });
    expect(status.json.result.structuredContent).toMatchObject({
      service: 'agent-core',
      serverName: 'agent-core',
      version: '0.4.0',
      authentication: 'bearer-api-key',
      key: { id: created.metadata.id, name: 'integration-client' },
    });

    const capabilities = await mcpRequest(baseUrl, created.key, {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'agent_core_capabilities', arguments: {} },
    });
    expect(capabilities.json.result.structuredContent).toMatchObject({
      stage: 'v3-hybrid-capability-registry',
      enabled: expect.arrayContaining([
        'mcp.streamable_http', 'auth.api_key', 'auth.oauth2',
        'tool.read_file', 'tool.write_file', 'tool.search_files', 'tool.execute_command',
        'tool.capability_recommend', 'tool.capability_search', 'tool.skill_load',
      ]),
      deferred: expect.arrayContaining(['git.semantic_tools', 'gui.automation']),
    });
  });
});

