import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { startAgentCoreService } from '../src/index.js';

const roots: string[] = [];
const blockers: Server[] = [];

async function config(port = 0): Promise<AppConfig> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-core-runtime-'));
  roots.push(root);
  return {
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
