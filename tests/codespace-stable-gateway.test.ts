import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string) => readFile(path.join(root, relative), 'utf8');

const workerFile = 'cloudflare/agent-core-gateway/worker.mjs';
const adminFile = 'scripts/codespace/stable-gateway-admin.mjs';
const updateScript = 'scripts/codespace/update-stable-gateway.sh';
const deployScript = 'scripts/codespace/deploy-stable-gateway.sh';

describe('stable Cloudflare Worker gateway contract', () => {
  it('tracks a stable Worker source and Codespace update/deploy automation without the old backend hostname', async () => {
    for (const file of [workerFile, adminFile, updateScript, deployScript]) {
      expect(existsSync(path.join(root, file)), `${file} must exist`).toBe(true);
    }
    if (![workerFile, adminFile, updateScript, deployScript].every((file) => existsSync(path.join(root, file)))) return;

    const tracked = new Set(execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).trim().split('\n'));
    for (const file of [workerFile, adminFile, updateScript, deployScript]) {
      expect(tracked.has(file), `${file} must be tracked`).toBe(true);
    }

    const all = (await Promise.all([workerFile, adminFile, updateScript, deployScript].map(read))).join('\n');
    expect(all).not.toContain('ominous-xylophone-69xxp4v76vv93xq64');
    expect(all).not.toMatch(/agent_core_live_[A-Za-z0-9_-]+/);
  });

  it('Worker resolves BACKEND_URL from env, preserves streaming, and rewrites OAuth identity to the stable origin', async () => {
    expect(existsSync(path.join(root, workerFile))).toBe(true);
    if (!existsSync(path.join(root, workerFile))) return;

    const worker = (await import(`${pathToFileURL(path.join(root, workerFile)).href}?t=${Date.now()}`)).default as {
      fetch(request: Request, env: Record<string, string>): Promise<Response>;
    };

    const originalFetch = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      seen.push(request.url);
      const url = new URL(request.url);
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        return new Response(JSON.stringify({
          issuer: 'https://replacement-8765.app.github.dev',
          authorization_endpoint: 'https://replacement-8765.app.github.dev/oauth/authorize',
          token_endpoint: 'https://replacement-8765.app.github.dev/oauth/token',
          registration_endpoint: 'https://replacement-8765.app.github.dev/oauth/register',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{"error":"unauthorized"}', {
        status: 401,
        headers: {
          'content-type': 'application/json',
          'www-authenticate': 'Bearer resource_metadata="https://replacement-8765.app.github.dev/.well-known/oauth-protected-resource/mcp", scope="mcp:tools"',
        },
      });
    }) as typeof fetch;

    try {
      const env = { BACKEND_URL: 'https://replacement-8765.app.github.dev' };
      const metadata = await worker.fetch(new Request('https://agent-core-gateway.example/.well-known/oauth-authorization-server'), env);
      const metadataJson = await metadata.json() as Record<string, string>;
      expect(metadataJson.issuer).toBe('https://agent-core-gateway.example');
      expect(metadataJson.authorization_endpoint).toBe('https://agent-core-gateway.example/oauth/authorize');
      expect(metadata.headers.get('x-agent-core-backend-host')).toBe('replacement-8765.app.github.dev');

      const mcp = await worker.fetch(new Request('https://agent-core-gateway.example/mcp'), env);
      expect(mcp.status).toBe(401);
      expect(mcp.headers.get('www-authenticate')).toContain('https://agent-core-gateway.example/.well-known/oauth-protected-resource/mcp');
      expect(seen).toContain('https://replacement-8765.app.github.dev/.well-known/oauth-authorization-server');
      expect(seen).toContain('https://replacement-8765.app.github.dev/mcp');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('auto-discovers a unique Cloudflare account from the API token and keeps explicit account ID as an override', async () => {
    const admin = await import(`${pathToFileURL(path.join(root, adminFile)).href}?t=${Date.now()}`) as Record<string, any>;
    let requests = 0;
    const fakeFetch = async (input: RequestInfo | URL): Promise<Response> => {
      requests += 1;
      expect(String(input)).toBe('https://api.cloudflare.com/client/v4/accounts');
      return Response.json({ success: true, result: [{ id: 'auto-account-123' }] });
    };

    await expect(admin.resolveCloudflareAccountId({
      accountId: 'explicit-account-456',
      apiToken: 'token-redacted',
      fetchImpl: fakeFetch,
    })).resolves.toBe('explicit-account-456');
    expect(requests).toBe(0);

    await expect(admin.resolveCloudflareAccountId({
      apiToken: 'token-redacted',
      fetchImpl: fakeFetch,
    })).resolves.toBe('auto-account-123');
    expect(requests).toBe(1);

    await expect(admin.resolveCloudflareAccountId({
      apiToken: 'token-redacted',
      fetchImpl: async () => Response.json({ success: true, result: [] }),
    })).rejects.toThrow('CLOUDFLARE_ACCOUNT_ID_NOT_FOUND');

    await expect(admin.resolveCloudflareAccountId({
      apiToken: 'token-redacted',
      fetchImpl: async () => Response.json({ success: true, result: [{ id: 'a' }, { id: 'b' }] }),
    })).rejects.toThrow('CLOUDFLARE_ACCOUNT_ID_AMBIGUOUS');
  });

  it('gateway admin updates only BACKEND_URL through the Cloudflare secret API and verifies all public gates', async () => {
    expect(existsSync(path.join(root, adminFile))).toBe(true);
    if (!existsSync(path.join(root, adminFile))) return;

    const admin = await import(`${pathToFileURL(path.join(root, adminFile)).href}?t=${Date.now()}`) as Record<string, any>;
    expect(admin.validateBackendUrl('https://replacement-8765.app.github.dev')).toBe('https://replacement-8765.app.github.dev');
    expect(() => admin.validateBackendUrl('http://replacement-8765.app.github.dev')).toThrow('STABLE_GATEWAY_BACKEND_URL_INVALID');
    expect(() => admin.validateBackendUrl('https://example.com')).toThrow('STABLE_GATEWAY_BACKEND_URL_INVALID');

    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? init.body : undefined;
      calls.push({ url, method, body });

      if (url.includes('/workers/scripts/agent-core-gateway/secrets')) {
        return Response.json({ success: true, result: { name: 'BACKEND_URL', type: 'secret_text' } });
      }
      if (url === 'https://agent-core-gateway.example/health') {
        return new Response(JSON.stringify({ status: 'ok', version: '0.5.3', memory: { healthy: true }, continuity: { healthy: true }, execution: { healthy: true } }), {
          status: 200,
          headers: { 'x-agent-core-backend-host': 'replacement-8765.app.github.dev' },
        });
      }
      if (url.endsWith('/.well-known/oauth-authorization-server')) {
        return Response.json({
          issuer: 'https://agent-core-gateway.example',
          authorization_endpoint: 'https://agent-core-gateway.example/oauth/authorize',
          token_endpoint: 'https://agent-core-gateway.example/oauth/token',
          registration_endpoint: 'https://agent-core-gateway.example/oauth/register',
        });
      }
      if (url.endsWith('/.well-known/oauth-protected-resource/mcp')) {
        return Response.json({ resource: 'https://agent-core-gateway.example/mcp', authorization_servers: ['https://agent-core-gateway.example'] });
      }
      if (url.endsWith('/mcp')) {
        return new Response('{"error":"unauthorized"}', {
          status: 401,
          headers: { 'www-authenticate': 'Bearer resource_metadata="https://agent-core-gateway.example/.well-known/oauth-protected-resource/mcp", scope="mcp:tools"' },
        });
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    };

    await admin.updateBackendSecret({
      accountId: 'account123',
      apiToken: 'token-redacted',
      workerName: 'agent-core-gateway',
      backendUrl: 'https://replacement-8765.app.github.dev',
      fetchImpl: fakeFetch,
    });
    await admin.verifyStableGateway({
      stableBaseUrl: 'https://agent-core-gateway.example',
      backendUrl: 'https://replacement-8765.app.github.dev',
      expectedVersion: '0.5.3',
      fetchImpl: fakeFetch,
    });

    const secretCall = calls.find((call) => call.url.includes('/secrets'));
    expect(secretCall?.method).toBe('PUT');
    expect(JSON.parse(secretCall?.body ?? '{}')).toEqual({
      name: 'BACKEND_URL',
      text: 'https://replacement-8765.app.github.dev',
      type: 'secret_text',
    });
  });

  it('Codespace lifecycle updates the stable gateway only after direct readiness and then publishes stable connection metadata', async () => {
    const ensure = await read('scripts/codespace/ensure-running.sh');
    const common = await read('scripts/codespace/common.sh');

    expect(common).toContain('AGENT_CORE_STABLE_GATEWAY_BASE_URL');
    expect(common).toContain('AGENT_CORE_CLOUDFLARE_WORKER_NAME');
    expect(common).toContain('[[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]');
    expect(common).not.toContain('account_present=0');
    expect(await read(updateScript)).not.toContain("CLOUDFLARE_ACCOUNT_ID is unavailable.");
    expect(await read(deployScript)).not.toContain("CLOUDFLARE_ACCOUNT_ID is unavailable.");
    expect(ensure).toContain('update-stable-gateway.sh');
    expect(ensure.indexOf('update-stable-gateway.sh')).toBeGreaterThan(ensure.indexOf('Expected unauthenticated /mcp to return 401'));
    expect(ensure).toContain('cloudflare-workers-stable-gateway');
    expect(ensure).toContain('AGENT_CORE_STABLE_GATEWAY_REQUIRED');
  });
});
