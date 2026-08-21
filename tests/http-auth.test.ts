import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { FileKeyStore } from '../src/auth/key-store.js';
import { createHttpHandler } from '../src/http/app.js';
import { FileAuditLogger } from '../src/logging/audit-log.js';

const tempDirs: string[] = [];
const servers: Server[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'commander-http-'));
  tempDirs.push(dir);
  return dir;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('HTTP authentication', () => {
  it('serves health without authentication', async () => {
    const root = await tempRoot();
    const handler = createHttpHandler({
      keyStore: new FileKeyStore(path.join(root, 'data')),
      auditLogger: new FileAuditLogger(path.join(root, 'logs')),
      mcpHandler: async () => { throw new Error('MCP hook must not run'); },
    });
    const baseUrl = await listen(createServer(handler));

    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok', service: 'commander-mcp' });
  });

  it.each([
    [undefined, 'missing bearer'],
    ['Basic abc', 'malformed bearer'],
    ['Bearer cmdr_live_invalid', 'invalid bearer'],
  ])('returns 401 for %s (%s)', async (authorization) => {
    const root = await tempRoot();
    const handler = createHttpHandler({
      keyStore: new FileKeyStore(path.join(root, 'data')),
      auditLogger: new FileAuditLogger(path.join(root, 'logs')),
      mcpHandler: async () => { throw new Error('MCP hook must not run'); },
    });
    const baseUrl = await listen(createServer(handler));
    const headers = authorization ? { Authorization: authorization } : undefined;
    const response = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'unauthorized' });
  });

  it('passes a verified key to the MCP hook and never logs the raw token', async () => {
    const root = await tempRoot();
    const keyStore = new FileKeyStore(path.join(root, 'data'));
    const auditLogger = new FileAuditLogger(path.join(root, 'logs'));
    const created = await keyStore.create('chatgpt');
    let receivedKeyId: string | null = null;

    const handler = createHttpHandler({
      keyStore,
      auditLogger,
      mcpHandler: async (_request, response, key) => {
        receivedKeyId = key.id;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, keyId: key.id }));
      },
    });
    const baseUrl = await listen(createServer(handler));

    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${created.key}` },
    });
    expect(response.status).toBe(200);
    expect(receivedKeyId).toBe(created.metadata.id);

    const audit = await readFile(auditLogger.filePath, 'utf8');
    expect(audit).toContain(created.metadata.id);
    expect(audit).toContain('chatgpt');
    expect(audit).not.toContain(created.key);
  });
});
