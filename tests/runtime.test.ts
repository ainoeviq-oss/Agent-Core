import { createServer, type Server } from 'node:http';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type AppConfig } from '../src/config.js';
import { startAgentCoreService } from '../src/index.js';
import { watchShutdownRequest } from '../src/runtime/shutdown-request.js';

const roots: string[] = [];
const blockers: Server[] = [];

async function config(port = 0): Promise<AppConfig> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-core-runtime-'));
  roots.push(root);
  return {
    ...loadConfig({}, root),
    host: '127.0.0.1',
    port,
    dataDir: path.join(root, 'data'),
    logDir: path.join(root, 'logs'),
    capabilityDir: path.join(root, 'capabilities'),
    allowedRoots: [root],
  };
}

afterEach(async () => {
  await Promise.all(blockers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Agent Core runtime', () => {
  it('starts, serves health, and closes its listener', async () => {
    const service = await startAgentCoreService(await config());
    expect(service.server.listening).toBe(true);
    const response = await fetch(`http://${service.host}:${service.port}/health`);
    expect(response.status).toBe(200);

    await service.close();
    expect(service.server.listening).toBe(false);
  });

  it('closes an initialized memory facade idempotently with the Agent Core service', async () => {
    const runtimeConfig = await config();
    runtimeConfig.memory = {
      ...runtimeConfig.memory,
      enabled: true,
      dbPath: path.join(path.dirname(runtimeConfig.dataDir), 'runtime', 'memory', 'runtime-test.sqlite'),
    };
    const service = await startAgentCoreService(runtimeConfig);
    const before = await service.memory.status();
    expect(before.enabled).toBe(true);
    expect(before.healthy).toBe(true);

    await service.close();
    await service.close();
    expect(service.server.listening).toBe(false);
    expect(service.memory.currentState).toBe('closed');
  });

  it('consumes a local shutdown request exactly once and invokes the graceful close callback', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-core-shutdown-request-'));
    roots.push(root);
    const requestPath = path.join(root, 'agent-core.shutdown.request');
    let calls = 0;
    const watcher = watchShutdownRequest(requestPath, async () => {
      calls += 1;
    }, { pollIntervalMs: 10 });

    await writeFile(requestPath, 'stop\n', 'utf8');
    const deadline = Date.now() + 1000;
    while (calls === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(calls).toBe(1);
    await expect(access(requestPath)).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toBe(1);
    watcher.close();
  });

  it('rejects startup when the configured port is already in use', async () => {
    const blocker = createServer((_request, response) => response.end('occupied'));
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    blockers.push(blocker);
    const port = (blocker.address() as AddressInfo).port;

    await expect(startAgentCoreService(await config(port))).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });
  });
});
