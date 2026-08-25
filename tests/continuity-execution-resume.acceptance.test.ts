import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
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

async function fixture(label: string) {
  const root = await mkdtemp(path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), `agent-core-continuity-exec-resume-${label}-`));
  roots.push(root);
  const work = path.join(root, 'work');
  await mkdir(work, { recursive: true });
  const defaults = loadConfig({}, root);
  const runtime = createRuntimeServices(
    [root], path.join(root, 'capabilities'), undefined,
    { ...defaults.memory, enabled: true, dbPath: path.join(root, 'runtime', 'memory', 'resume.sqlite') },
    { ...defaults.execution, enabled: true, dbPath: path.join(root, 'runtime', 'execution', 'resume.sqlite'), logRoot: path.join(root, 'runtime', 'execution', 'runs') },
  );
  await runtime.memory.status({ principalId: 'warmup', projectId: root });
  await runtime.execution.open();
  runtimes.push(runtime);
  const keyStore = new FileKeyStore(path.join(root, 'data'));
  const principalA = await keyStore.create(`resume-a-${label}`);
  const principalB = await keyStore.create(`resume-b-${label}`);
  const server = createServer(createHttpHandler({
    keyStore,
    auditLogger: new FileAuditLogger(path.join(root, 'logs')),
    mcpHandler: createMcpHttpHandler(runtime),
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { root, work, runtime, principalA, principalB, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function call(baseUrl: string, key: string, name: string, args: Record<string, unknown> = {}) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 401, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await response.json() as Record<string, any>;
  const text = raw.result?.content?.[0]?.text;
  let result: Record<string, any> = {};
  if (typeof text === 'string') { try { result = JSON.parse(text); } catch { result = { text }; } }
  return { raw, result };
}

async function route(f: Awaited<ReturnType<typeof fixture>>, task: string, key = f.principalA.key) {
  const routed = await call(f.baseUrl, key, 'capability_route', { task, context: `Workspace ${f.root}` });
  expect(routed.raw.result?.isError).not.toBe(true);
  for (const required of routed.result.requiredSkillLoads ?? []) {
    const loaded = await call(f.baseUrl, key, 'skill_load', { id: required.id, routeContextId: routed.result.routeContextId });
    expect(loaded.raw.result?.isError).not.toBe(true);
  }
  return routed.result;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(runtimes.splice(0).map(async (runtime) => {
    await runtime.execution.close().catch(() => undefined);
    await runtime.memory.close().catch(() => undefined);
  }));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('continuity + execution cross-session resume', () => {
  it('fresh same-principal route rehydrates the active run and can inspect the older run without the original route', async () => {
    const f = await fixture('active');
    const first = await route(f, 'Build two independent commands and preserve continuity');
    const created = await call(f.baseUrl, f.principalA.key, 'execution_create', {
      routeContextId: first.routeContextId,
      objective: 'durable active run',
      nodes: [{ id: 'A', purpose: 'A', command: "Write-Output 'A'", cwd: f.work }],
    });
    expect(created.raw.result?.isError).not.toBe(true);
    const runId = created.result.runId as string;

    const fresh = await route(f, 'Inspect the active execution state from a fresh session');
    expect(fresh.continuitySnapshot.activeRuns.map((run: any) => run.runId)).toContain(runId);
    expect(fresh.continuitySnapshot.activeRuns.find((run: any) => run.runId === runId)?.continuityTaskId).toBe(first.continuityTaskId);

    const status = await call(f.baseUrl, f.principalA.key, 'execution_status', { runId });
    expect(status.raw.result?.isError).not.toBe(true);
    expect(status.result.runId).toBe(runId);
    expect(status.result.state).toBe('planned');
  });

  it('execution resume summary and old-run access remain principal scoped', async () => {
    const f = await fixture('scope');
    const first = await route(f, 'Create an owned execution run');
    const created = await call(f.baseUrl, f.principalA.key, 'execution_create', {
      routeContextId: first.routeContextId,
      objective: 'principal scoped run',
      nodes: [{ id: 'A', purpose: 'A', command: "Write-Output 'A'", cwd: f.work }],
    });
    const runId = created.result.runId as string;

    const otherRoute = await route(f, 'Inspect my own execution state', f.principalB.key);
    expect(otherRoute.continuitySnapshot.activeRuns.map((run: any) => run.runId)).not.toContain(runId);
    const denied = await call(f.baseUrl, f.principalB.key, 'execution_status', { runId });
    expect(denied.raw.result?.isError).toBe(true);
  });
});