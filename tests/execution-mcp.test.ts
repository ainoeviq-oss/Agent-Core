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
import { printCommand, retryMarkerCommand, sleepCommand } from './helpers/platform-command.js';

const roots: string[] = [];
const servers: Server[] = [];
const runtimes: RuntimeServices[] = [];

async function fixture(label: string) {
  const root = await mkdtemp(path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), `agent-core-execution-mcp-${label}-`));
  roots.push(root);
  const work = path.join(root, 'work');
  await mkdir(work, { recursive: true });
  const defaults = loadConfig({}, root);
  const runtime = createRuntimeServices(
    [root],
    path.join(root, 'capabilities'),
    undefined,
    { ...defaults.memory, enabled: false },
    {
      ...defaults.execution,
      enabled: true,
      dbPath: path.join(root, 'runtime', 'execution', 'mcp.sqlite'),
      logRoot: path.join(root, 'runtime', 'execution', 'runs'),
      maxConcurrency: 4,
      maxNodes: 128,
      waitMaxMs: 60_000,
    },
  );
  await runtime.execution.open();
  runtimes.push(runtime);

  const keyStore = new FileKeyStore(path.join(root, 'data'));
  const principalA = await keyStore.create(`execution-a-${label}`);
  const principalB = await keyStore.create(`execution-b-${label}`);
  const app = createHttpHandler({
    keyStore,
    auditLogger: new FileAuditLogger(path.join(root, 'logs')),
    mcpHandler: createMcpHttpHandler(runtime),
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return {
    root,
    work,
    runtime,
    principalA,
    principalB,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    scopeA: { principalId: principalA.metadata.id, projectId: root },
  };
}

async function request(baseUrl: string, key: string, body: unknown) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  });
  return await response.json() as Record<string, any>;
}

async function call(baseUrl: string, key: string, name: string, args: Record<string, unknown> = {}) {
  const raw = await request(baseUrl, key, {
    jsonrpc: '2.0', id: 301, method: 'tools/call', params: { name, arguments: args },
  });
  const text = raw.result?.content?.[0]?.text;
  let result: Record<string, any> = {};
  if (typeof text === 'string') {
    try { result = JSON.parse(text) as Record<string, any>; }
    catch { result = { text }; }
  }
  return { raw, result };
}

async function route(f: Awaited<ReturnType<typeof fixture>>, key = f.principalA.key) {
  const routed = await call(f.baseUrl, key, 'capability_route', {
    task: 'Implement and run a dependency-aware multi-command execution DAG',
    context: `Workspace root is ${f.root}`,
  });
  expect(routed.raw.result?.isError).not.toBe(true);
  for (const required of routed.result.requiredSkillLoads ?? []) {
    const loaded = await call(f.baseUrl, key, 'skill_load', {
      id: required.id,
      routeContextId: routed.result.routeContextId,
    });
    expect(loaded.raw.result?.isError).not.toBe(true);
  }
  return routed.result;
}

function expectOk(value: Awaited<ReturnType<typeof call>>) {
  expect(value.raw.result?.isError).not.toBe(true);
  return value.result;
}

function expectErrorCode(value: Awaited<ReturnType<typeof call>>, code: string) {
  expect(value.raw.result?.isError).toBe(true);
  expect(value.result.error?.code).toBe(code);
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(runtimes.splice(0).map(async (runtime) => {
    await runtime.execution.close().catch(() => undefined);
    await runtime.memory.close().catch(() => undefined);
  }));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('first-class execution MCP surface', () => {
  it('registers eight bounded execution tools and route-requires only the five mutation tools', async () => {
    const f = await fixture('surface');
    const listed = await request(f.baseUrl, f.principalA.key, {
      jsonrpc: '2.0', id: 302, method: 'tools/list', params: {},
    });
    const tools = listed.result.tools as Array<Record<string, any>>;
    const names = tools.map((tool) => tool.name);
    expect(names).toHaveLength(52);
    const execution = [
      'execution_create', 'execution_start', 'execution_status', 'execution_wait',
      'execution_logs', 'execution_add_nodes', 'execution_retry', 'execution_cancel',
    ];
    for (const name of execution) expect(names).toContain(name);

    for (const name of ['execution_create', 'execution_start', 'execution_add_nodes', 'execution_retry', 'execution_cancel']) {
      const tool = tools.find((entry) => entry.name === name)!;
      expect(tool.inputSchema.required).toContain('routeContextId');
      expect(tool.description).toContain('capability_route');
    }
    for (const name of ['execution_status', 'execution_wait', 'execution_logs']) {
      const tool = tools.find((entry) => entry.name === name)!;
      expect(tool.inputSchema?.required ?? []).not.toContain('routeContextId');
    }
    expect(tools.find((entry) => entry.name === 'execution_wait')!.inputSchema.properties.timeoutMs.maximum).toBe(60_000);
    expect(tools.find((entry) => entry.name === 'execution_logs')!.inputSchema.properties.maxBytes.maximum).toBe(1024 * 1024);
  });

  it('execution_create persists a planned DAG without starting a process and rejects a fabricated route', async () => {
    const f = await fixture('create');
    const routed = await route(f);
    const createdCall = await call(f.baseUrl, f.principalA.key, 'execution_create', {
      routeContextId: routed.routeContextId,
      objective: 'Create does not start',
      maxConcurrency: 2,
      nodes: [
        { id: 'B', purpose: 'B', command: "Write-Output 'B'", cwd: f.work },
        { id: 'A', purpose: 'A', command: "Write-Output 'A'", cwd: f.work },
      ],
    });
    const created = expectOk(createdCall);
    expect(created).toMatchObject({ state: 'planned', readyNodeIds: ['A', 'B'], runningNodeIds: [], terminalNodeIds: [] });
    expect(created.nodes.map((node: any) => node.nodeId)).toEqual(['A', 'B']);
    expect(await f.runtime.execution.store.listAttempts(f.scopeA, created.runId)).toEqual([]);

    const status = expectOk(await call(f.baseUrl, f.principalA.key, 'execution_status', { runId: created.runId }));
    expect(status.state).toBe('planned');
    expect(status.lastEventSequence).toBeGreaterThanOrEqual(3);

    const denied = await call(f.baseUrl, f.principalA.key, 'execution_create', {
      routeContextId: '00000000-0000-4000-8000-000000000000',
      objective: 'must fail',
      nodes: [{ id: 'X', purpose: 'X', command: "Write-Output 'X'", cwd: f.work }],
    });
    expectErrorCode(denied, 'ROUTE_NOT_FOUND');
  });

  it('execution_start + execution_wait return factual terminal events and execution_logs reads bounded byte-offset output', async () => {
    const f = await fixture('wait-logs');
    const routed = await route(f);
    const created = expectOk(await call(f.baseUrl, f.principalA.key, 'execution_create', {
      routeContextId: routed.routeContextId,
      objective: 'wait and log fixture',
      nodes: [{
        id: 'A', purpose: 'A',
        command: printCommand('ABCDEFGHIJK', 'ERR-A'),
        cwd: f.work,
      }],
    }));
    const afterSequence = created.lastEventSequence;
    const started = expectOk(await call(f.baseUrl, f.principalA.key, 'execution_start', {
      routeContextId: routed.routeContextId,
      runId: created.runId,
    }));
    expect(['running', 'completed']).toContain(started.state);

    const waited = expectOk(await call(f.baseUrl, f.principalA.key, 'execution_wait', {
      runId: created.runId,
      afterSequence,
      eventTypes: ['node.succeeded'],
      nodeIds: ['A'],
      timeoutMs: 5_000,
    }));
    expect(waited.timedOut).toBe(false);
    expect(waited.event).toMatchObject({ eventType: 'node.succeeded', nodeId: 'A' });

    const first = expectOk(await call(f.baseUrl, f.principalA.key, 'execution_logs', {
      runId: created.runId, nodeId: 'A', attemptNo: 1, stream: 'stdout', offset: 0, maxBytes: 5,
    }));
    expect(first).toMatchObject({ data: 'ABCDE', offset: 0, nextOffset: 5, eof: false });
    const second = expectOk(await call(f.baseUrl, f.principalA.key, 'execution_logs', {
      runId: created.runId, nodeId: 'A', attemptNo: 1, stream: 'stdout', offset: first.nextOffset, maxBytes: 1024,
    }));
    expect(`${first.data}${second.data}`).toBe('ABCDEFGHIJK');
    const stderr = expectOk(await call(f.baseUrl, f.principalA.key, 'execution_logs', {
      runId: created.runId, nodeId: 'A', attemptNo: 1, stream: 'stderr', offset: 0, maxBytes: 1024,
    }));
    expect(stderr.data).toContain('ERR-A');
  }, 10_000);

  it('a fresh same-principal route can mutate an older owned run while another principal/project cannot observe it', async () => {
    const f = await fixture('ownership');
    const originalRoute = await route(f);
    const created = expectOk(await call(f.baseUrl, f.principalA.key, 'execution_create', {
      routeContextId: originalRoute.routeContextId,
      objective: 'old owned run',
      nodes: [{ id: 'A', purpose: 'A', command: printCommand('A\n'), cwd: f.work }],
    }));

    const deniedRead = await call(f.baseUrl, f.principalB.key, 'execution_status', { runId: created.runId });
    expectErrorCode(deniedRead, 'EXECUTION_RUN_NOT_FOUND');
    const routeB = await route(f, f.principalB.key);
    const deniedStart = await call(f.baseUrl, f.principalB.key, 'execution_start', {
      routeContextId: routeB.routeContextId,
      runId: created.runId,
    });
    expectErrorCode(deniedStart, 'EXECUTION_RUN_NOT_FOUND');

    const freshRouteA = await route(f);
    const started = expectOk(await call(f.baseUrl, f.principalA.key, 'execution_start', {
      routeContextId: freshRouteA.routeContextId,
      runId: created.runId,
    }));
    expect(['running', 'completed']).toContain(started.state);
    const waited = expectOk(await call(f.baseUrl, f.principalA.key, 'execution_wait', {
      runId: created.runId, afterSequence: created.lastEventSequence,
      eventTypes: ['node.succeeded'], nodeIds: ['A'], timeoutMs: 5_000,
    }));
    expect(waited.event?.nodeId).toBe('A');
  }, 10_000);

  it('execution_add_nodes atomically adds dynamic C after A while B runs and rejects a cyclic batch with no partial inserts', async () => {
    const f = await fixture('dynamic');
    const routed = await route(f);
    const created = expectOk(await call(f.baseUrl, f.principalA.key, 'execution_create', {
      routeContextId: routed.routeContextId,
      objective: 'dynamic C fixture',
      nodes: [
        { id: 'B', purpose: 'slow B', command: sleepCommand(3000, '', 'B\n'), cwd: f.work },
        { id: 'A', purpose: 'fast A', command: sleepCommand(100, '', 'A\n'), cwd: f.work },
      ],
    }));
    expectOk(await call(f.baseUrl, f.principalA.key, 'execution_start', {
      routeContextId: routed.routeContextId, runId: created.runId,
    }));
    const aDone = expectOk(await call(f.baseUrl, f.principalA.key, 'execution_wait', {
      runId: created.runId, afterSequence: created.lastEventSequence,
      eventTypes: ['node.succeeded'], nodeIds: ['A'], timeoutMs: 5_000,
    }));
    expect(aDone.event?.nodeId).toBe('A');
    expect(aDone.state.nodes.find((node: any) => node.nodeId === 'B')?.state).toBe('running');

    const added = expectOk(await call(f.baseUrl, f.principalA.key, 'execution_add_nodes', {
      routeContextId: routed.routeContextId,
      runId: created.runId,
      nodes: [{ id: 'C', purpose: 'dynamic C', command: printCommand('C\n'), cwd: f.work, dependsOn: ['A'] }],
    }));
    expect(added.nodes.map((node: any) => node.nodeId)).toEqual(['A', 'B', 'C']);
    const cDone = expectOk(await call(f.baseUrl, f.principalA.key, 'execution_wait', {
      runId: created.runId, afterSequence: aDone.lastEventSequence,
      eventTypes: ['node.succeeded'], nodeIds: ['C'], timeoutMs: 5_000,
    }));
    expect(cDone.event?.nodeId).toBe('C');
    expect(cDone.state.nodes.find((node: any) => node.nodeId === 'B')?.state).toBe('running');

    const beforeInvalid = expectOk(await call(f.baseUrl, f.principalA.key, 'execution_status', { runId: created.runId }));
    const invalid = await call(f.baseUrl, f.principalA.key, 'execution_add_nodes', {
      routeContextId: routed.routeContextId,
      runId: created.runId,
      nodes: [
        { id: 'D', purpose: 'D', command: "Write-Output 'D'", cwd: f.work, dependsOn: ['E'] },
        { id: 'E', purpose: 'E', command: "Write-Output 'E'", cwd: f.work, dependsOn: ['D'] },
      ],
    });
    expectErrorCode(invalid, 'EXECUTION_DAG_CYCLE');
    const afterInvalid = expectOk(await call(f.baseUrl, f.principalA.key, 'execution_status', { runId: created.runId }));
    expect(afterInvalid.nodes.map((node: any) => node.nodeId)).toEqual(beforeInvalid.nodes.map((node: any) => node.nodeId));

    expectOk(await call(f.baseUrl, f.principalA.key, 'execution_cancel', {
      routeContextId: routed.routeContextId, runId: created.runId,
    }));
  }, 15_000);

  it('execution_retry explicitly creates attempt 2 while attempt 1 logs remain readable', async () => {
    const f = await fixture('retry');
    const routed = await route(f);
    const markerPath = path.join(f.work, 'retry.marker');
    const command = retryMarkerCommand(markerPath);
    const created = expectOk(await call(f.baseUrl, f.principalA.key, 'execution_create', {
      routeContextId: routed.routeContextId,
      objective: 'retry fixture',
      nodes: [{ id: 'A', purpose: 'retry A', command, cwd: f.work }],
    }));
    expectOk(await call(f.baseUrl, f.principalA.key, 'execution_start', {
      routeContextId: routed.routeContextId, runId: created.runId,
    }));
    const failed = expectOk(await call(f.baseUrl, f.principalA.key, 'execution_wait', {
      runId: created.runId, afterSequence: created.lastEventSequence,
      eventTypes: ['node.failed'], nodeIds: ['A'], timeoutMs: 5_000,
    }));
    expect(failed.event?.eventType).toBe('node.failed');

    expectOk(await call(f.baseUrl, f.principalA.key, 'execution_retry', {
      routeContextId: routed.routeContextId, runId: created.runId, nodeId: 'A',
    }));
    const succeeded = expectOk(await call(f.baseUrl, f.principalA.key, 'execution_wait', {
      runId: created.runId, afterSequence: failed.lastEventSequence,
      eventTypes: ['node.succeeded'], nodeIds: ['A'], timeoutMs: 5_000,
    }));
    expect(succeeded.event?.eventType).toBe('node.succeeded');
    const status = expectOk(await call(f.baseUrl, f.principalA.key, 'execution_status', { runId: created.runId }));
    expect(status.nodes[0]).toMatchObject({ nodeId: 'A', state: 'succeeded', attemptCount: 2 });

    const attempt1 = expectOk(await call(f.baseUrl, f.principalA.key, 'execution_logs', {
      runId: created.runId, nodeId: 'A', attemptNo: 1, stream: 'stderr', offset: 0, maxBytes: 1024,
    }));
    const attempt2 = expectOk(await call(f.baseUrl, f.principalA.key, 'execution_logs', {
      runId: created.runId, nodeId: 'A', attemptNo: 2, stream: 'stdout', offset: 0, maxBytes: 1024,
    }));
    expect(attempt1.data).toContain('attempt-one');
    expect(attempt2.data).toContain('attempt-two');
  }, 15_000);

  it('execution_cancel can cancel one running node without stopping unrelated work, then cancel the whole run', async () => {
    const f = await fixture('cancel');
    const routed = await route(f);
    const created = expectOk(await call(f.baseUrl, f.principalA.key, 'execution_create', {
      routeContextId: routed.routeContextId,
      objective: 'cancel fixture',
      nodes: [
        { id: 'B', purpose: 'B', command: sleepCommand(5000, '', 'B\n'), cwd: f.work },
        { id: 'A', purpose: 'A', command: sleepCommand(5000, '', 'A\n'), cwd: f.work },
      ],
    }));
    const started = expectOk(await call(f.baseUrl, f.principalA.key, 'execution_start', {
      routeContextId: routed.routeContextId, runId: created.runId,
    }));
    expect(started.runningNodeIds.sort()).toEqual(['A', 'B']);

    const beforeCancel = started.lastEventSequence;
    expectOk(await call(f.baseUrl, f.principalA.key, 'execution_cancel', {
      routeContextId: routed.routeContextId, runId: created.runId, nodeId: 'A',
    }));
    const cancelledA = expectOk(await call(f.baseUrl, f.principalA.key, 'execution_wait', {
      runId: created.runId, afterSequence: beforeCancel,
      eventTypes: ['node.cancelled'], nodeIds: ['A'], timeoutMs: 5_000,
    }));
    expect(cancelledA.event?.nodeId).toBe('A');
    expect(cancelledA.state.nodes.find((node: any) => node.nodeId === 'B')?.state).toBe('running');

    expectOk(await call(f.baseUrl, f.principalA.key, 'execution_cancel', {
      routeContextId: routed.routeContextId, runId: created.runId,
    }));
    const final = expectOk(await call(f.baseUrl, f.principalA.key, 'execution_status', { runId: created.runId }));
    expect(final.state).toBe('cancelled');
    expect(final.nodes.find((node: any) => node.nodeId === 'B')?.state).toBe('cancelled');
  }, 15_000);
});
