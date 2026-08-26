import http from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { createAnchorProxy } from '../src/codespace/anchor-proxy.js';

const stableBase = 'https://ominous-xylophone-69xxp4v76vv93xq64.app.github.dev';
const servers: http.Server[] = [];

async function listen(server: http.Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing_address');
  return `http://127.0.0.1:${address.port}`;
}

async function request(base: string, path: string, init: { method?: string; headers?: Record<string,string>; body?: string } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const url = new URL(path, base);
    const req = http.request(url, { method: init.method ?? 'GET', headers: init.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('Codespace anchor proxy', () => {
  it('rejects routes outside the Agent Core public surface', async () => {
    const backendUrl = await listen(http.createServer((_req, res) => res.end('backend')));
    const proxyUrl = await listen(createAnchorProxy({ publicBaseUrl: stableBase, resolveTarget: async () => ({ baseUrl: backendUrl, mode: 'local' }) }));
    const response = await request(proxyUrl, '/secret/internal');
    expect(response.status).toBe(404);
  });

  it('forwards request method/body and strips hop-by-hop proxy headers', async () => {
    const backendUrl = await listen(http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ method: req.method, body: Buffer.concat(chunks).toString('utf8'), connection: req.headers.connection, proxyAuthorization: req.headers['proxy-authorization'] }));
    }));
    const proxyUrl = await listen(createAnchorProxy({ publicBaseUrl: stableBase, resolveTarget: async () => ({ baseUrl: backendUrl, mode: 'remote' }) }));
    const response = await request(proxyUrl, '/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', connection: 'close', 'proxy-authorization': 'do-not-forward' },
      body: 'grant_type=refresh_token&refresh_token=opaque',
    });
    const parsed = JSON.parse(response.body) as Record<string, unknown>;
    expect(parsed.method).toBe('POST');
    expect(parsed.body).toContain('refresh_token=opaque');
    expect(parsed.proxyAuthorization).toBeUndefined();
  });

  it('streams MCP response chunks without waiting for the backend to finish', async () => {
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const backendUrl = await listen(http.createServer(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
      await secondGate;
      res.end('data: second\n\n');
    }));
    const proxyUrl = await listen(createAnchorProxy({ publicBaseUrl: stableBase, resolveTarget: async () => ({ baseUrl: backendUrl, mode: 'remote' }) }));

    const firstChunk = new Promise<string>((resolve, reject) => {
      const req = http.get(`${proxyUrl}/mcp`, (res) => {
        res.once('data', (chunk) => resolve(String(chunk)));
      });
      req.on('error', reject);
    });

    await expect(firstChunk).resolves.toContain('first');
    releaseSecond();
  });

  it('rewrites OAuth authorization metadata to the stable anchor origin', async () => {
    const remoteBase = 'https://replacement-8765.app.github.dev';
    const backendUrl = await listen(http.createServer((_req, res) => {
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        issuer: remoteBase,
        authorization_endpoint: `${remoteBase}/oauth/authorize`,
        token_endpoint: `${remoteBase}/oauth/token`,
        registration_endpoint: `${remoteBase}/oauth/register`,
        scopes_supported: ['mcp:tools'],
      }));
    }));
    const proxyUrl = await listen(createAnchorProxy({ publicBaseUrl: stableBase, resolveTarget: async () => ({ baseUrl: backendUrl, mode: 'remote', advertisedBaseUrl: remoteBase }) }));
    const response = await request(proxyUrl, '/.well-known/oauth-authorization-server');
    const parsed = JSON.parse(response.body) as Record<string, unknown>;
    expect(parsed.issuer).toBe(stableBase);
    expect(parsed.authorization_endpoint).toBe(`${stableBase}/oauth/authorize`);
    expect(parsed.token_endpoint).toBe(`${stableBase}/oauth/token`);
    expect(parsed.registration_endpoint).toBe(`${stableBase}/oauth/register`);
  });

  it('rewrites protected-resource metadata to the stable anchor resource', async () => {
    const remoteBase = 'https://replacement-8765.app.github.dev';
    const backendUrl = await listen(http.createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ resource: `${remoteBase}/mcp`, authorization_servers: [remoteBase], scopes_supported: ['mcp:tools'] }));
    }));
    const proxyUrl = await listen(createAnchorProxy({ publicBaseUrl: stableBase, resolveTarget: async () => ({ baseUrl: backendUrl, mode: 'remote', advertisedBaseUrl: remoteBase }) }));
    const response = await request(proxyUrl, '/.well-known/oauth-protected-resource/mcp');
    const parsed = JSON.parse(response.body) as Record<string, unknown>;
    expect(parsed.resource).toBe(`${stableBase}/mcp`);
    expect(parsed.authorization_servers).toEqual([stableBase]);
  });

  it('rewrites MCP WWW-Authenticate challenge URLs without changing the 401 truth', async () => {
    const remoteBase = 'https://replacement-8765.app.github.dev';
    const backendUrl = await listen(http.createServer((_req, res) => {
      res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${remoteBase}/.well-known/oauth-protected-resource/mcp", scope="mcp:tools"`, 'content-type': 'application/json' });
      res.end('{"error":"unauthorized"}');
    }));
    const proxyUrl = await listen(createAnchorProxy({ publicBaseUrl: stableBase, resolveTarget: async () => ({ baseUrl: backendUrl, mode: 'remote', advertisedBaseUrl: remoteBase }) }));
    const response = await request(proxyUrl, '/mcp');
    expect(response.status).toBe(401);
    expect(response.headers['www-authenticate']).toContain(`${stableBase}/.well-known/oauth-protected-resource/mcp`);
    expect(response.headers['www-authenticate']).not.toContain(remoteBase);
  });

  it('logs only bounded method/path/mode metadata and never request secrets', async () => {
    const entries: string[] = [];
    const backendUrl = await listen(http.createServer((_req, res) => res.end('{}')));
    const proxyUrl = await listen(createAnchorProxy({
      publicBaseUrl: stableBase,
      resolveTarget: async () => ({ baseUrl: backendUrl, mode: 'remote' }),
      log: (message) => entries.push(message),
    }));
    await request(proxyUrl, '/oauth/token', { method: 'POST', headers: { authorization: 'Bearer TOPSECRET', cookie: 'session=TOPSECRET' }, body: 'refresh_token=TOPSECRET' });
    const joined = entries.join('\n');
    expect(joined).toContain('POST /oauth/token');
    expect(joined).not.toContain('TOPSECRET');
    expect(joined).not.toContain('refresh_token');
    expect(joined).not.toContain('authorization');
    expect(joined).not.toContain('cookie');
  });
});
