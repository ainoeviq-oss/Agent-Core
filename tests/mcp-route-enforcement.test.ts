import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileKeyStore } from '../src/auth/key-store.js';
import type { RoutePlan } from '../src/capabilities/route-types.js';
import type { CapabilityRecord } from '../src/capabilities/types.js';
import { writeRegistryGeneration } from '../src/capabilities/registry-writer.js';
import { createHttpHandler } from '../src/http/app.js';
import { FileAuditLogger } from '../src/logging/audit-log.js';
import { createMcpHttpHandler } from '../src/mcp/handler.js';
import { createRuntimeServices } from '../src/runtime/services.js';

const roots: string[] = [];
const servers: Server[] = [];
const UNKNOWN_ROUTE = '00000000-0000-4000-8000-000000000001';

function nativeCapability(): CapabilityRecord {
  return {
    id: 'cap_native', name: 'native-frontend', displayName: 'Native Frontend', aliases: [],
    type: 'skill', category: 'frontend', categoryTitle: 'Frontend',
    declaredPurpose: 'Improve frontend visual hierarchy and spacing',
    functionalSummary: 'Audited frontend workflow',
    source: { url: 'https://example.invalid/native', repo: 'example/native', path: 'SKILL.md', sha: 'sha' },
    compatibility: ['chatgpt'], language: ['en'], triggers: ['frontend', 'spacing', 'hierarchy'],
    invocation: 'auto_candidate', inputsContext: ['task_context'], outputsArtifacts: [],
    requiredTools: ['read_file'], dependencies: [], sideEffects: [], risk: 'low',
    license: { status: 'verified', id: 'MIT' }, state: 'native_ready', nativeEligible: true,
    normalizedPath: 'normalized/skills/cap_native/SKILL.md', equivalenceGroup: null,
    catalogSha: 'fixture-sha', catalogFile: 'fixture.md', catalogRow: 1,
  };
}

function routePlan(overrides: Partial<RoutePlan> = {}): RoutePlan {
  return {
    tier: 'atomic', mode: 'atomic_direct', domain: 'general', confidence: 1, risk: 'low',
    recommendedCapabilities: [], requiredSkillLoads: [],
    allowedTools: ['list_directory', 'read_file', 'read_multiple_files', 'write_file', 'edit_file',
      'create_directory', 'move_file', 'get_file_info', 'search_files', 'execute_command', 'start_process'],
    verification: { required: false, suggestedTools: [] }, reasonCodes: ['test_route'],
    ...overrides,
  };
}

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-core-route-gate-'));
  roots.push(root);
  const capabilityDir = path.join(root, 'capabilities');
  const skillPath = path.join(capabilityDir, 'normalized', 'skills', 'cap_native', 'SKILL.md');
  await mkdir(path.dirname(skillPath), { recursive: true });
  await writeFile(skillPath, '# Native Frontend\n\nUse audited guidance.\n', 'utf8');
  await writeRegistryGeneration(capabilityDir, [nativeCapability()], {
    catalogSha: 'fixture-sha', generatedAt: '2026-08-23T00:00:00.000Z',
  });

  const keyStore = new FileKeyStore(path.join(root, 'data'));
  const principalA = await keyStore.create('principal-a');
  const principalB = await keyStore.create('principal-b');
  const runtime = createRuntimeServices([root], capabilityDir);
  const app = createHttpHandler({
    keyStore,
    auditLogger: new FileAuditLogger(path.join(root, 'logs')),
    mcpHandler: createMcpHttpHandler(runtime),
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { root, runtime, principalA, principalB, baseUrl: `http://127.0.0.1:${port}` };
}

async function call(baseUrl: string, key: string, name: string, args: Record<string, unknown> = {}) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 30, method: 'tools/call', params: { name, arguments: args } }),
  });
  return await response.json() as Record<string, any>;
}

function textBody(result: Record<string, any>) {
  return JSON.parse(result.result.content[0].text) as Record<string, any>;
}

function routeErrorCode(result: Record<string, any>) {
  return textBody(result).error?.code;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const gatedCases = [
  ['list_directory', (root: string) => ({ path: root }), 'filesystem', 'listDirectory'],
  ['read_file', (root: string) => ({ path: path.join(root, 'missing.txt') }), 'filesystem', 'readFile'],
  ['read_multiple_files', (root: string) => ({ paths: [path.join(root, 'a.txt')] }), 'filesystem', 'readMultipleFiles'],
  ['write_file', (root: string) => ({ path: path.join(root, 'write.txt'), content: 'blocked' }), 'filesystem', 'writeFile'],
  ['edit_file', (root: string) => ({ path: path.join(root, 'edit.txt'), oldString: 'a', newString: 'b' }), 'filesystem', 'editFile'],
  ['create_directory', (root: string) => ({ path: path.join(root, 'created') }), 'filesystem', 'createDirectory'],
  ['move_file', (root: string) => ({ source: path.join(root, 'a.txt'), destination: path.join(root, 'b.txt') }), 'filesystem', 'moveFile'],
  ['get_file_info', (root: string) => ({ path: path.join(root, 'a.txt') }), 'filesystem', 'getFileInfo'],
  ['search_files', (root: string) => ({ path: root, query: 'needle', mode: 'content' }), 'search', 'search'],
  ['execute_command', (root: string) => ({ command: "Write-Output 'blocked'", cwd: root }), 'processes', 'execute'],
  ['start_process', (root: string) => ({ command: 'Start-Sleep -Seconds 5', cwd: root }), 'processes', 'start'],
] as const;

describe('Agent Core route enforcement', () => {
  it('rejects fabricated route IDs for all 11 gated tools before underlying services run', async () => {
    const { root, runtime, principalA, baseUrl } = await setup();
    const spies = gatedCases.map(([, , service, method]) => (
      vi.spyOn((runtime as any)[service], method as any)
    ));
    const results: Record<string, any>[] = [];

    for (const [name, args] of gatedCases) {
      results.push(await call(baseUrl, principalA.key, name, { ...args(root), routeContextId: UNKNOWN_ROUTE }));
    }

    for (const result of results) {
      expect(result.result.isError).toBe(true);
      expect(routeErrorCode(result)).toBe('ROUTE_NOT_FOUND');
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('rejects a route created by principal A when principal B attempts write_file', async () => {
    const { root, runtime, principalA, principalB, baseUrl } = await setup();
    const target = path.join(root, 'principal-isolation.txt');
    const route = runtime.routes.create(principalA.metadata.id, routePlan({ allowedTools: ['write_file'] }));
    const writeSpy = vi.spyOn(runtime.filesystem, 'writeFile');

    const result = await call(baseUrl, principalB.key, 'write_file', {
      path: target, content: 'must-not-write', routeContextId: route.routeContextId,
    });

    expect(result.result.isError).toBe(true);
    expect(routeErrorCode(result)).toBe('ROUTE_PRINCIPAL_MISMATCH');
    expect(writeSpy).not.toHaveBeenCalled();
    await expect(access(target)).rejects.toThrow();
  });

  it('requires a routed native-ready skill before execution and allows the same route after skill_load', async () => {
    const { root, runtime, principalA, baseUrl } = await setup();
    const target = path.join(root, 'dashboard.txt');
    await writeFile(target, 'dashboard evidence', 'utf8');
    const route = runtime.routes.create(principalA.metadata.id, routePlan({
      tier: 'domain_complex', mode: 'skill_guided', allowedTools: ['read_file'],
      requiredSkillLoads: [{ id: 'cap_native', name: 'native-frontend' }],
    }));

    const blocked = await call(baseUrl, principalA.key, 'read_file', {
      path: target, routeContextId: route.routeContextId,
    });
    expect(blocked.result.isError).toBe(true);
    expect(routeErrorCode(blocked)).toBe('ROUTE_SKILL_REQUIRED');

    const loaded = await call(baseUrl, principalA.key, 'skill_load', {
      id: 'cap_native', routeContextId: route.routeContextId,
    });
    expect(loaded.result.isError).not.toBe(true);

    const allowed = await call(baseUrl, principalA.key, 'read_file', {
      path: target, routeContextId: route.routeContextId,
    });
    expect(allowed.result.isError).not.toBe(true);
    expect(allowed.result.content[0].text).toContain('dashboard evidence');
  });

  it('keeps stop_process available as a direct recovery tool without route context', async () => {
    const { root, runtime, principalA, baseUrl } = await setup();
    const started = await runtime.processes.start(
      "Write-Output 'route-recovery-ready'; Start-Sleep -Seconds 30",
      { cwd: root },
    );

    const stopped = await call(baseUrl, principalA.key, 'stop_process', {
      sessionId: started.sessionId,
    });
    expect(stopped.result.isError).not.toBe(true);
    expect(textBody(stopped)).toMatchObject({ stopped: true });
  });
});
