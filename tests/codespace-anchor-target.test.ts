import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  localAnchorTarget,
  readAnchorTarget,
  verifyAndWriteRemoteBackend,
  verifyRemoteBackend,
  writeAnchorTargetAtomic,
} from '../src/codespace/anchor-target.js';

const roots: string[] = [];

async function tempStatePath(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-core-anchor-target-'));
  roots.push(root);
  return path.join(root, 'anchor', 'backend.json');
}

function response(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function healthyFetch(base = 'https://replacement-8765.app.github.dev'): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
    if (url.pathname === '/health') return response({ status: 'ok', service: 'agent-core', version: '0.5.4', memory: { healthy: true }, continuity: { healthy: true }, execution: { healthy: true } });
    if (url.pathname === '/.well-known/oauth-authorization-server') return response({ issuer: base, authorization_endpoint: `${base}/oauth/authorize`, token_endpoint: `${base}/oauth/token`, registration_endpoint: `${base}/oauth/register` });
    if (url.pathname === '/mcp') return response({ error: 'unauthorized' }, 401);
    return response({ error: 'not_found' }, 404);
  }) as typeof fetch;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Codespace anchor target state', () => {
  it('falls back to the local internal backend when target state is absent', async () => {
    const statePath = await tempStatePath();
    expect(await readAnchorTarget(statePath)).toEqual(localAnchorTarget());
  });

  it('falls back to local when target state is malformed', async () => {
    const statePath = await tempStatePath();
    await writeFile(statePath, '{broken', { recursive: undefined } as never).catch(async () => {
      await writeAnchorTargetAtomic(localAnchorTarget(), statePath);
      await writeFile(statePath, '{broken');
    });
    expect(await readAnchorTarget(statePath)).toEqual(localAnchorTarget());
  });

  it('writes target state atomically and enforces private file permissions on POSIX hosts', async () => {
    const statePath = await tempStatePath();
    const target = { ...localAnchorTarget(), verifiedAt: '2026-08-27T00:00:00.000Z' };
    await writeAnchorTargetAtomic(target, statePath);
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual(target);
    if (process.platform !== 'win32') {
      expect((await stat(statePath)).mode & 0o777).toBe(0o600);
    }
  });

  it('rejects non-HTTPS and non-Codespaces remote backends before network access', async () => {
    const neverFetch = (async () => { throw new Error('network_should_not_run'); }) as typeof fetch;
    await expect(verifyRemoteBackend('http://replacement-8765.app.github.dev', { fetchImpl: neverFetch })).rejects.toThrow('ANCHOR_BACKEND_URL_INVALID');
    await expect(verifyRemoteBackend('https://example.com', { fetchImpl: neverFetch })).rejects.toThrow('ANCHOR_BACKEND_URL_INVALID');
    await expect(verifyRemoteBackend('https://ominous-xylophone-69xxp4v76vv93xq64.app.github.dev', { fetchImpl: neverFetch })).rejects.toThrow('ANCHOR_BACKEND_URL_INVALID');
  });

  it('verifies health, OAuth metadata and MCP 401 before accepting a remote backend', async () => {
    const base = 'https://replacement-8765.app.github.dev';
    const target = await verifyRemoteBackend(base, { fetchImpl: healthyFetch(base), now: () => new Date('2026-08-27T00:00:00.000Z') });
    expect(target).toEqual({
      mode: 'remote',
      baseUrl: base,
      advertisedBaseUrl: base,
      codespaceName: 'replacement',
      verified: true,
      verifiedAt: '2026-08-27T00:00:00.000Z',
    });
  });

  it('rejects an unhealthy Agent Core backend', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/health') return response({ status: 'ok', service: 'agent-core', memory: { healthy: false }, continuity: { healthy: true }, execution: { healthy: true } });
      return response({}, 200);
    }) as typeof fetch;
    await expect(verifyRemoteBackend('https://replacement-8765.app.github.dev', { fetchImpl })).rejects.toThrow('ANCHOR_BACKEND_HEALTH_INVALID');
  });

  it('does not mutate the active target when remote verification fails', async () => {
    const statePath = await tempStatePath();
    const local = { ...localAnchorTarget(), verifiedAt: '2026-08-27T00:00:00.000Z' };
    await writeAnchorTargetAtomic(local, statePath);
    const failingFetch = (async () => response({ status: 'down' }, 503)) as typeof fetch;
    await expect(verifyAndWriteRemoteBackend('https://replacement-8765.app.github.dev', statePath, { fetchImpl: failingFetch })).rejects.toThrow();
    expect(await readAnchorTarget(statePath)).toEqual(local);
  });
});
