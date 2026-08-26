import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileKeyStore } from '../src/auth/key-store.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { startAgentCoreService, type AgentCoreService } from '../src/index.js';
import { printCommand, sleepCommand } from './helpers/platform-command.js';

const roots: string[] = [];
const services: AgentCoreService[] = [];

async function fixture(label: string): Promise<{ root: string; work: string; config: AppConfig }> {
  const root = await mkdtemp(path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), `agent-core-exec-unified-${label}-`));
  roots.push(root);
  const work = path.join(root, 'work');
  await mkdir(work, { recursive: true });
  const config = loadConfig({}, root);
  config.host = '127.0.0.1';
  config.port = 0;
  config.dataDir = path.join(root, 'runtime', 'data');
  config.logDir = path.join(root, 'runtime', 'logs');
  config.capabilityDir = path.join(root, 'capabilities');
  config.allowedRoots = [root];
  config.execution.enabled = true;
  config.execution.dbPath = path.join(root, 'runtime', 'execution', 'agent-core-execution.sqlite');
  config.execution.logRoot = path.join(root, 'runtime', 'execution', 'runs');
  return { root, work, config };
}

async function start(config: AppConfig) {
  const service = await startAgentCoreService(config);
  services.push(service);
  return service;
}

async function fileSizeOrZero(filePath: string) {
  try { return (await stat(filePath)).size; } catch { return 0; }
}

async function mcpCall(service: AgentCoreService, key: string, name: string, args: Record<string, unknown> = {}) {
  const response = await fetch(`http://${service.host}:${service.port}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 701, method: 'tools/call', params: { name, arguments: args } }),
  });
  return await response.json() as Record<string, any>;
}

afterEach(async () => {
  for (const service of services.splice(0)) {
    try { await service.close(); } catch {}
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('unified Agent Core continuity + execution lifecycle', () => {
  it('reports memory, continuity, and execution independently through /health and agent_core_status', async () => {
    const { root, config } = await fixture('healthy');
    const service = await start(config);
    expect(service.execution.currentState).toBe('healthy');

    const healthResponse = await fetch(`http://${service.host}:${service.port}/health`);
    expect(healthResponse.status).toBe(200);
    expect(await healthResponse.json()).toMatchObject({
      status: 'ok',
      memory: { enabled: true, healthy: true, state: 'healthy', integrity: 'ok' },
      continuity: { enabled: true, healthy: true, snapshotReady: true, counts: expect.any(Object) },
      execution: { enabled: true, healthy: true, state: 'healthy', integrity: 'ok', activeRuns: 0, queuedSync: 0 },
    });

    const keyStore = new FileKeyStore(config.dataDir);
    const principal = await keyStore.create('unified-health-principal');
    const status = await mcpCall(service, principal.key, 'agent_core_status');
    expect(status.result.structuredContent).toMatchObject({
      memory: { healthy: true, state: 'healthy' },
      continuity: { enabled: true, healthy: true, snapshotReady: true },
      execution: { enabled: true, healthy: true, state: 'healthy', activeRuns: 0, queuedSync: 0 },
    });
    expect(status.result.structuredContent.workspaceRoots).toEqual([root]);
  });

  it('keeps OAuth/MCP available when execution DB is corrupt and exposes execution as degraded separately', async () => {
    const { config } = await fixture('execution-corrupt');
    await mkdir(path.dirname(config.execution.dbPath), { recursive: true });
    await writeFile(config.execution.dbPath, 'not sqlite execution', 'utf8');

    const service = await start(config);
    expect(service.server.listening).toBe(true);
    expect(service.execution.currentState).toBe('degraded');
    const health = await (await fetch(`http://${service.host}:${service.port}/health`)).json() as any;
    expect(health.status).toBe('ok');
    expect(health.memory.healthy).toBe(true);
    expect(health.execution).toMatchObject({ enabled: true, healthy: false, state: 'degraded' });

    const oauth = await fetch(`http://${service.host}:${service.port}/.well-known/oauth-authorization-server`);
    expect(oauth.status).toBe(200);
    const keyStore = new FileKeyStore(config.dataDir);
    const principal = await keyStore.create('execution-degraded-principal');
    const status = await mcpCall(service, principal.key, 'agent_core_status');
    expect(status.result.structuredContent.execution).toMatchObject({ enabled: true, healthy: false, state: 'degraded' });
  });

  it('keeps execution factual state + queued DMF sync visible when memory is degraded', async () => {
    const { root, work, config } = await fixture('memory-corrupt');
    await mkdir(path.dirname(config.memory.dbPath), { recursive: true });
    await writeFile(config.memory.dbPath, 'not sqlite memory', 'utf8');
    const service = await start(config);
    const scope = { principalId: 'principal-memory-degraded', projectId: root };

    const run = await service.execution.create(scope, {
      objective: 'failure must remain factual while memory is degraded',
      continuityTaskId: 'task-degraded-memory',
      nodes: [{ id: 'A', purpose: 'fail factually', command: printCommand('', 'failure\n', 9), cwd: work }],
    });
    await service.execution.start(scope, run.runId);
    const terminal = await service.execution.wait(scope, run.runId, run.lastEventSequence, { eventTypes: ['run.failed'] }, 5000);
    expect(terminal.state.state).toBe('failed');
    await service.execution.memoryBridge?.drain();

    const health = await service.execution.health(scope);
    expect(health).toMatchObject({ enabled: true, healthy: true, state: 'healthy' });
    expect(health.queuedSync).toBeGreaterThan(0);
    const httpHealth = await (await fetch(`http://${service.host}:${service.port}/health`)).json() as any;
    expect(httpHealth.memory.healthy).toBe(false);
    expect(httpHealth.execution.healthy).toBe(true);
    expect(httpHealth.execution.queuedSync).toBeGreaterThan(0);
  }, 10_000);

  it('graceful service close stops new runs, interrupts active nodes, and checkpoints both SQLite WALs', async () => {
    const { root, work, config } = await fixture('graceful-close');
    const first = await start(config);
    const scope = { principalId: 'principal-graceful-close', projectId: root };
    const run = await first.execution.create(scope, {
      objective: 'long run interrupted by graceful service close',
      continuityTaskId: 'task-graceful-close',
      nodes: [{ id: 'A', purpose: 'sleep', command: sleepCommand(30_000, 'started\n'), cwd: work }],
    });
    await first.execution.start(scope, run.runId);
    expect((await first.execution.status(scope, run.runId))?.nodes[0]?.state).toBe('running');

    await first.close();
    services.splice(services.indexOf(first), 1);
    await expect(first.execution.create(scope, {
      objective: 'must reject after close',
      nodes: [{ id: 'B', purpose: 'B', command: printCommand('B\n'), cwd: work }],
    })).rejects.toThrow(/closed|not open/i);
    expect(await fileSizeOrZero(`${config.memory.dbPath}-wal`)).toBe(0);
    expect(await fileSizeOrZero(`${config.execution.dbPath}-wal`)).toBe(0);

    const second = await start(config);
    const recovered = await second.execution.status(scope, run.runId);
    expect(recovered?.state).toBe('interrupted');
    expect(recovered?.nodes[0]?.state).toBe('interrupted');
  }, 15_000);
});