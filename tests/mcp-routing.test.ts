import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { FileKeyStore } from '../src/auth/key-store.js';
import { loadConfig } from '../src/config.js';
import type { CapabilityRecord } from '../src/capabilities/types.js';
import { writeRegistryGeneration } from '../src/capabilities/registry-writer.js';
import { createHttpHandler } from '../src/http/app.js';
import { FileAuditLogger } from '../src/logging/audit-log.js';
import { createMcpHttpHandler } from '../src/mcp/handler.js';
import { createRuntimeServices } from '../src/runtime/services.js';

const roots: string[] = [];
const servers: Server[] = [];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function frontendCapability(): CapabilityRecord {
  return {
    id: 'frontend-quality',
    name: 'frontend-quality',
    displayName: 'Frontend Quality',
    aliases: ['frontend design'],
    type: 'skill',
    category: 'frontend',
    categoryTitle: 'Frontend',
    declaredPurpose: 'Improve frontend dashboard visual hierarchy spacing and layout',
    functionalSummary: 'Refactor frontend presentation quality and visual hierarchy',
    source: {
      url: 'https://example.invalid/frontend-quality',
      repo: 'example/frontend-quality',
      path: 'SKILL.md',
      sha: 'source-sha',
    },
    compatibility: ['chatgpt'],
    language: ['en'],
    triggers: ['frontend', 'dashboard', 'spacing', 'hierarchy', 'refactor'],
    invocation: 'auto_candidate',
    inputsContext: ['task_context'],
    outputsArtifacts: [],
    requiredTools: ['read_file'],
    dependencies: [],
    sideEffects: [],
    risk: 'low',
    license: { status: 'verified', id: 'MIT' },
    state: 'native_ready',
    nativeEligible: true,
    normalizedPath: 'normalized/skills/frontend-quality/SKILL.md',
    equivalenceGroup: null,
    catalogSha: 'fixture-sha',
    catalogFile: 'fixture.md',
    catalogRow: 1,
  };
}
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-core-routing-mcp-'));
  roots.push(root);
  const capabilityDir = path.join(root, 'capabilities');
  const skillPath = path.join(
    capabilityDir,
    'normalized',
    'skills',
    'frontend-quality',
    'SKILL.md',
  );
  await mkdir(path.dirname(skillPath), { recursive: true });
  await writeFile(skillPath, '# Frontend Quality\n\nUse the audited frontend workflow.\n', 'utf8');
  await writeRegistryGeneration(capabilityDir, [frontendCapability()], {
    catalogSha: 'fixture-sha',
    generatedAt: '2026-08-23T00:00:00.000Z',
  });

  const keyStore = new FileKeyStore(path.join(root, 'data'));
  const created = await keyStore.create('routing-client');
  const baseMemory = loadConfig({}, root).memory;
  const runtime = createRuntimeServices([root], capabilityDir, undefined, { ...baseMemory, enabled: false });
  const app = createHttpHandler({
    keyStore,
    auditLogger: new FileAuditLogger(path.join(root, 'logs')),
    mcpHandler: createMcpHttpHandler(runtime),
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    created,
    runtime,
  };
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

async function call(
  baseUrl: string,
  key: string,
  name: string,
  args: Record<string, unknown> = {},
) {
  return mcpRequest(baseUrl, key, {
    jsonrpc: '2.0',
    id: 20,
    method: 'tools/call',
    params: { name, arguments: args },
  });
}

async function listTools(baseUrl: string, key: string) {
  const result = await mcpRequest(baseUrl, key, {
    jsonrpc: '2.0',
    id: 21,
    method: 'tools/list',
    params: {},
  });
  return result.json.result.tools as Array<Record<string, any>>;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe('Agent Core MCP automatic capability routing', () => {
  it('replaces capability_recommend with capability_route while exposing 53 routed, github, memory, continuity, execution, and observability tools', async () => {
    const { baseUrl, created } = await setup();
    const tools = await listTools(baseUrl, created.key);
    const names = tools.map((tool) => tool.name);

    expect(names).toHaveLength(53);
    expect(names).toEqual(expect.arrayContaining(['task_checkpoint', 'continuity_status', 'continuity_get_task', 'continuity_frontier']));
    expect(names).toContain('capability_route');
    expect(names).not.toContain('capability_recommend');

    const routeTool = tools.find((tool) => tool.name === 'capability_route');
    expect(routeTool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it('creates a principal-bound route and marks a routed skill load', async () => {
    const { baseUrl, created, runtime } = await setup();
    const routed = await call(baseUrl, created.key, 'capability_route', {
      task: 'Refactor this frontend dashboard to improve visual hierarchy and spacing',
    });
    const route = JSON.parse(routed.json.result.content[0].text);
    expect(route.routeContextId).toMatch(UUID_RE);
    expect(route).toMatchObject({
      tier: 'domain_complex',
      mode: 'skill_guided',
      domain: 'frontend',
    });
    expect(route.recommendedCapabilities[0]).toMatchObject({ id: 'frontend-quality' });
    expect(route).not.toHaveProperty('principalId');

    const loaded = await call(baseUrl, created.key, 'skill_load', {
      id: 'frontend-quality',
      routeContextId: route.routeContextId,
    });
    expect(loaded.json.result.isError).not.toBe(true);
    expect(runtime.routes.get(route.routeContextId)?.loadedSkillIds)
      .toContain('frontend-quality');
  });
});
