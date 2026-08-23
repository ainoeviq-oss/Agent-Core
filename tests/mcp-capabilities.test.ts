import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { FileKeyStore } from '../src/auth/key-store.js';
import type { CapabilityRecord } from '../src/capabilities/types.js';
import { writeRegistryGeneration } from '../src/capabilities/registry-writer.js';
import { createHttpHandler } from '../src/http/app.js';
import { FileAuditLogger } from '../src/logging/audit-log.js';
import { createMcpHttpHandler } from '../src/mcp/handler.js';
import { createRuntimeServices } from '../src/runtime/services.js';

const roots: string[] = [];
const servers: Server[] = [];

function capability(id: string, name: string, state: CapabilityRecord['state'], nativeEligible: boolean, normalizedPath: string | null): CapabilityRecord {
  return {
    id, name, displayName: name, aliases: [], type: 'skill', category: 'debugging', categoryTitle: 'Debugging',
    declaredPurpose: `${name} purpose`, functionalSummary: `${name} function`,
    source: { url: `https://example.invalid/${name}`, repo: `example/${name}`, path: 'SKILL.md', sha: 'source-sha' },
    compatibility: ['CX'], language: ['en'], triggers: [`intent:${name}`], invocation: 'auto_candidate',
    inputsContext: ['task_context'], outputsArtifacts: [], requiredTools: ['read_file'], dependencies: [], sideEffects: [],
    risk: 'low', license: { status: 'verified', id: 'MIT' }, state, nativeEligible, normalizedPath,
    equivalenceGroup: null, catalogSha: 'fixture-sha', catalogFile: 'fixture.md', catalogRow: 1,
  };
}
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-core-cap-'));
  roots.push(root);
  const capabilityDir = path.join(root, 'capabilities');
  const nativePath = path.join(capabilityDir, 'normalized', 'skills', 'cap_native', 'SKILL.md');
  await mkdir(path.dirname(nativePath), { recursive: true });
  await writeFile(nativePath, '# Native Skill\n\nUse evidence, patch minimally, verify tests.\n', 'utf8');
  await writeRegistryGeneration(capabilityDir, [
    capability('cap_native', 'native-debugger', 'native_ready', true, 'normalized/skills/cap_native/SKILL.md'),
    capability('cap_cataloged', 'catalog-only', 'cataloged', false, null),
  ], { catalogSha: 'fixture-sha', generatedAt: '2026-08-22T00:00:00.000Z' });

  const keyStore = new FileKeyStore(path.join(root, 'data'));
  const created = await keyStore.create('capability-client');
  const app = createHttpHandler({
    keyStore,
    auditLogger: new FileAuditLogger(path.join(root, 'logs')),
    mcpHandler: createMcpHttpHandler(createRuntimeServices([root], capabilityDir)),
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

async function call(baseUrl: string, key: string, name: string, args: Record<string, unknown> = {}) {
  return mcpRequest(baseUrl, key, {
    jsonrpc: '2.0', id: 10, method: 'tools/call',
    params: { name, arguments: args },
  });
}

async function listTools(baseUrl: string, key: string) {
  const result = await mcpRequest(baseUrl, key, {
    jsonrpc: '2.0', id: 11, method: 'tools/list', params: {},
  });
  return result.json.result.tools as Array<Record<string, any>>;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const CAPABILITY_TOOLS = [
  'capability_recommend', 'capability_search', 'capability_get',
  'skill_load', 'capability_dependencies', 'capability_coverage',
];

const OPERATIONAL_TOOLS = [
  'agent_core_status', 'agent_core_capabilities', 'workspace_info', 'list_directory',
  'read_file', 'read_multiple_files', 'write_file', 'edit_file', 'create_directory',
  'move_file', 'get_file_info', 'search_files', 'execute_command', 'start_process',
  'read_process_output', 'stop_process', 'list_processes',
];

describe('Agent Core MCP capability registry tools', () => {
  it('discovers six read-only capability tools without losing operational tools', async () => {
    const { baseUrl, created } = await setup();
    const tools = await listTools(baseUrl, created.key);
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([...OPERATIONAL_TOOLS, ...CAPABILITY_TOOLS]));

    for (const name of CAPABILITY_TOOLS) {
      const tool = tools.find((entry) => entry.name === name);
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      });
    }
  });
  it('serves compact discovery metadata and gates skill instruction loading', async () => {
    const { baseUrl, created } = await setup();

    const coverage = await call(baseUrl, created.key, 'capability_coverage');
    const coverageBody = JSON.parse(coverage.json.result.content[0].text);
    expect(coverageBody).toMatchObject({ total: 2, nativeReady: 1 });

    const searched = await call(baseUrl, created.key, 'capability_search', { query: 'native debugger' });
    const searchBody = JSON.parse(searched.json.result.content[0].text);
    expect(searchBody.results[0]).toMatchObject({ id: 'cap_native', name: 'native-debugger' });
    expect(JSON.stringify(searchBody)).not.toContain('Use evidence, patch minimally');

    const recommended = await call(baseUrl, created.key, 'capability_recommend', { task: 'debug a build failure' });
    const recommendBody = JSON.parse(recommended.json.result.content[0].text);
    expect(recommendBody.results.some((item: { id: string }) => item.id === 'cap_native')).toBe(true);

    const got = await call(baseUrl, created.key, 'capability_get', { id: 'cap_native' });
    expect(JSON.parse(got.json.result.content[0].text)).toMatchObject({ id: 'cap_native', state: 'native_ready' });

    const dependencies = await call(baseUrl, created.key, 'capability_dependencies', { id: 'cap_native' });
    expect(JSON.parse(dependencies.json.result.content[0].text)).toMatchObject({
      id: 'cap_native', requiredTools: ['read_file'], risk: 'low', state: 'native_ready',
    });

    const loaded = await call(baseUrl, created.key, 'skill_load', { id: 'cap_native' });
    const loadBody = JSON.parse(loaded.json.result.content[0].text);
    expect(loadBody.capability).toMatchObject({ id: 'cap_native', state: 'native_ready' });
    expect(loadBody.instructions).toContain('Use evidence, patch minimally, verify tests.');

    const rejected = await call(baseUrl, created.key, 'skill_load', { id: 'cap_cataloged' });
    expect(rejected.json.result.isError).toBe(true);
    expect(rejected.json.result.content[0].text).toMatch(/not native-ready/i);
  });
});
