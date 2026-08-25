import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileKeyStore } from '../src/auth/key-store.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { startAgentCoreService, type AgentCoreService } from '../src/index.js';

const roots: string[] = [];
const services: AgentCoreService[] = [];

async function fixtureConfig(): Promise<{ root: string; config: AppConfig }> {
  const root = await mkdtemp(path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), 'agent-core-memory-unified-'));
  roots.push(root);
  const config = loadConfig({}, root);
  config.host = '127.0.0.1';
  config.port = 0;
  config.dataDir = path.join(root, 'runtime', 'data');
  config.logDir = path.join(root, 'runtime', 'logs');
  config.capabilityDir = path.join(root, 'capabilities');
  config.allowedRoots = [root];
  return { root, config };
}

async function start(config: AppConfig): Promise<AgentCoreService> {
  const service = await startAgentCoreService(config);
  services.push(service);
  return service;
}

async function mcpCall(service: AgentCoreService, key: string, name: string, args: Record<string, unknown> = {}) {
  const response = await fetch(`http://${service.host}:${service.port}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 170, method: 'tools/call', params: { name, arguments: args } }),
  });
  return await response.json() as Record<string, any>;
}

function textBody(result: Record<string, any>) {
  return JSON.parse(result.result.content[0].text) as Record<string, any>;
}

async function fileSizeOrZero(filePath: string): Promise<number> {
  try { return (await stat(filePath)).size; } catch { return 0; }
}

afterEach(async () => {
  for (const service of services.splice(0)) {
    try { await service.close(); } catch {}
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('unified Agent Core deterministic memory lifecycle', () => {
  it('enables and warms DMF by default, reports health, checkpoints cleanly, and rehydrates the same DB after restart', async () => {
    const { root, config } = await fixtureConfig();
    expect(config.memory.enabled).toBe(true);
    expect(config.memory.dbPath).toBe(path.join(root, 'runtime', 'memory', 'agent-core-memory.sqlite'));

    const first = await start(config);
    expect(first.memory.currentState).toBe('healthy');

    const health = await fetch(`http://${first.host}:${first.port}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      status: 'ok',
      service: 'agent-core',
      memory: { enabled: true, healthy: true, state: 'healthy', integrity: 'ok' },
    });

    const keyStore = new FileKeyStore(config.dataDir);
    const principal = await keyStore.create('lifecycle-principal');
    const status = await mcpCall(first, principal.key, 'agent_core_status');
    expect(status.result.structuredContent.memory).toMatchObject({
      enabled: true,
      healthy: true,
      state: 'healthy',
      integrity: 'ok',
    });

    const scope = { principalId: principal.metadata.id, projectId: root };
    const committed = await first.memory.commit({
      scope,
      canonicalKey: 'decision.lifecycle.rehydrate',
      kind: 'decision',
      value: 'The unified launcher must rehydrate the same deterministic memory database.',
      sourceType: 'test',
    });

    await first.close();
    services.splice(services.indexOf(first), 1);
    expect(await fileSizeOrZero(`${config.memory.dbPath}-wal`)).toBe(0);

    const second = await start(config);
    expect(second.memory.currentState).toBe('healthy');
    const recall = await second.memory.search({ scope, query: 'unified launcher rehydrate deterministic memory database', limit: 10 });
    expect(recall.hits.map((hit) => hit.memoryId)).toContain(committed.memoryId);
    expect(await fileSizeOrZero(config.memory.dbPath)).toBeGreaterThan(0);
  });

  it('keeps OAuth and MCP alive when the memory DB is corrupt and exposes degraded memory instead of invented context', async () => {
    const { config } = await fixtureConfig();
    await mkdir(path.dirname(config.memory.dbPath), { recursive: true });
    await writeFile(config.memory.dbPath, 'this is not sqlite', 'utf8');

    const service = await start(config);
    expect(service.server.listening).toBe(true);
    expect(service.memory.currentState).toBe('degraded');

    const health = await fetch(`http://${service.host}:${service.port}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      status: 'ok',
      service: 'agent-core',
      memory: { enabled: true, healthy: false, state: 'degraded' },
    });

    const oauth = await fetch(`http://${service.host}:${service.port}/.well-known/oauth-authorization-server`);
    expect(oauth.status).toBe(200);
    expect(await oauth.json()).toMatchObject({ grant_types_supported: ['authorization_code', 'refresh_token'] });

    const keyStore = new FileKeyStore(config.dataDir);
    const principal = await keyStore.create('degraded-memory-principal');
    const routed = textBody(await mcpCall(service, principal.key, 'capability_route', { task: 'Create a small proof file' }));
    expect(routed).toMatchObject({
      memoryStatus: 'degraded',
      memoryContextId: null,
      memorySummary: [],
      blockingGuardrails: [],
      priorFailures: [],
      relatedDecisions: [],
      memoryConfidence: 0,
      memorySnapshotHash: null,
    });
    const status = await mcpCall(service, principal.key, 'agent_core_status');
    expect(status.result.structuredContent.memory).toMatchObject({ enabled: true, healthy: false, state: 'degraded' });
  });
});
