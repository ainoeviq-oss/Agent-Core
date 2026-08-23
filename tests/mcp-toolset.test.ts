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
const GATED_TOOLS = [
  'list_directory', 'read_file', 'read_multiple_files', 'write_file', 'edit_file',
  'create_directory', 'move_file', 'get_file_info', 'search_files', 'execute_command',
  'start_process',
] as const;
const DIRECT_TOOLS = [
  'workspace_info', 'read_process_output', 'stop_process', 'list_processes',
] as const;

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-core-toolset-'));
  roots.push(root);
  const keyStore = new FileKeyStore(path.join(root, 'data'));
  const created = await keyStore.create('toolset-client');
  const runtime = createRuntimeServices([root]);
  const app = createHttpHandler({
    keyStore,
    auditLogger: new FileAuditLogger(path.join(root, 'logs')),
    mcpHandler: createMcpHttpHandler(runtime),
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { root, created, baseUrl: `http://127.0.0.1:${port}` };
}

async function call(baseUrl: string, key: string, name: string, args: Record<string, unknown> = {}) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return { response, json: await response.json() as Record<string, any> };
}

async function listTools(baseUrl: string, key: string) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });
  return (await response.json() as Record<string, any>).result.tools as Array<Record<string, any>>;
}

function body(result: Record<string, any>) {
  const payload = result.json ?? result;
  return JSON.parse(payload.result.content[0].text) as Record<string, any>;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Agent Core MCP V2 toolset', () => {
  it('discovers route-aware operational tools while preserving direct recovery tools', async () => {
    const { baseUrl, created } = await setup();
    const tools = await listTools(baseUrl, created.key);
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      'workspace_info', ...GATED_TOOLS, 'read_process_output', 'stop_process', 'list_processes',
    ]));

    for (const name of GATED_TOOLS) {
      const tool = tools.find((entry) => entry.name === name)!;
      expect(tool.description).toContain('Obtain routeContextId from capability_route before using this tool.');
      expect(tool.inputSchema.properties.routeContextId).toMatchObject({ type: 'string', format: 'uuid' });
      expect(tool.inputSchema.required).toContain('routeContextId');
    }
    for (const name of DIRECT_TOOLS) {
      const tool = tools.find((entry) => entry.name === name)!;
      expect(tool.inputSchema?.required ?? []).not.toContain('routeContextId');
    }
  });

  it('performs representative write, read, search, and command calls under one coherent route', async () => {
    const { root, baseUrl, created } = await setup();
    const routed = await call(baseUrl, created.key, 'capability_route', {
      task: 'Create hello.txt, read it, search for needle, and then run a verification command.',
      context: `Workspace root is ${root}`,
    });
    const route = body(routed);
    expect(route.mode).toBe('capability_guided');
    const routeContextId = route.routeContextId as string;

    const file = path.join(root, 'hello.txt');
    const written = await call(baseUrl, created.key, 'write_file', {
      path: file, content: 'hello needle', mode: 'rewrite', routeContextId,
    });
    expect(written.json.result.isError).not.toBe(true);

    const read = await call(baseUrl, created.key, 'read_file', { path: file, routeContextId });
    expect(read.json.result.content[0].text).toContain('hello needle');

    const searched = await call(baseUrl, created.key, 'search_files', {
      path: root, query: 'needle', mode: 'content', maxResults: 10, routeContextId,
    });
    expect(searched.json.result.content[0].text).toContain('hello.txt');

    const executed = await call(baseUrl, created.key, 'execute_command', {
      command: "Write-Output 'mcp-command-ok'", cwd: root, timeoutMs: 5000, routeContextId,
    });
    expect(executed.json.result.content[0].text).toContain('mcp-command-ok');

    const workspace = await call(baseUrl, created.key, 'workspace_info');
    const workspaceBody = body(workspace) as { roots: string[] };
    expect(workspaceBody.roots).toContain(root);
  });
});
