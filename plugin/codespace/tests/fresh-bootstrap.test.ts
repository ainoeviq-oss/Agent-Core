import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const startup = readFileSync(path.join(pluginRoot, 'scripts', 'ensure-running.sh'), 'utf8');
const bootstrap = JSON.parse(readFileSync(path.join(pluginRoot, 'config', 'bootstrap.defaults.json'), 'utf8')) as {
  controlPlaneBaseUrl?: string;
  publicRuntimeKey?: string;
  tunnelId?: string;
};
const workerPath = path.join(pluginRoot, 'control-plane', 'worker.mjs');

describe('fresh Codespace public bootstrap contract', () => {
  it('tracks a non-secret public bootstrap identity and fixed proxy endpoint', () => {
    expect(bootstrap.controlPlaneBaseUrl).toMatch(/^https:\/\/codespace-control-plane\.[A-Za-z0-9.-]+\.workers\.dev$/);
    expect(bootstrap.publicRuntimeKey).toMatch(/^codespace_public_v1_[A-Za-z0-9_-]+$/);
    expect(bootstrap.tunnelId).toMatch(/^tunnel_[A-Za-z0-9_-]+$/);
  });

  it('prefers the persistent local runtime key, but falls back to tracked public proxy mode on a fresh machine', () => {
    expect(startup).toContain('CREDENTIAL_MODE="local-runtime-key"');
    expect(startup).toContain('CREDENTIAL_MODE="public-control-plane-proxy"');
    expect(startup).toContain('BOOTSTRAP_CONTROL_PLANE_BASE_URL');
    expect(startup).toContain('BOOTSTRAP_PUBLIC_RUNTIME_KEY');
    expect(startup).toContain('--control-plane-base-url "$CONTROL_PLANE_BASE_URL"');
    expect(startup.indexOf('if [[ -s "$RUNTIME_API_KEY_FILE" ]]')).toBeLessThan(startup.indexOf('CREDENTIAL_MODE="public-control-plane-proxy"'));
  });

  it('ships a proxy that only permits the fixed tunnel metadata/poll/response surface and replaces client authorization', async () => {
    const worker = (await import(`${pathToFileURL(workerPath).href}?t=${Date.now()}`)).default as {
      fetch(request: Request, env: Record<string, string>): Promise<Response>;
    };

    const calls: Array<{ url: string; method: string; authorization: string | null }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      calls.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.get('authorization'),
      });
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    try {
      const env = { OPENAI_TUNNEL_RUNTIME_KEY: 'server-side-secret-for-test-only' };
      const headers = { authorization: `Bearer ${bootstrap.publicRuntimeKey}` };
      const base = bootstrap.controlPlaneBaseUrl!;
      const tunnel = bootstrap.tunnelId!;

      for (const [method, suffix] of [
        ['GET', `/v1/tunnels/${tunnel}`],
        ['POST', `/v1/tunnels/${tunnel}/poll`],
        ['POST', `/v1/tunnels/${tunnel}/response`],
      ] as const) {
        const response = await worker.fetch(new Request(`${base}${suffix}`, { method, headers }), env);
        expect(response.status).toBe(200);
      }

      expect(calls).toHaveLength(3);
      for (const call of calls) {
        expect(call.url).toMatch(/^https:\/\/api\.openai\.com\/v1\/tunnels\//);
        expect(call.authorization).toBe('Bearer server-side-secret-for-test-only');
        expect(call.authorization).not.toContain(bootstrap.publicRuntimeKey!);
      }

      for (const request of [
        new Request(`${base}/v1/models`, { headers }),
        new Request(`${base}/v1/files`, { headers }),
        new Request(`${base}/v1/tunnels/tunnel_other`, { headers }),
        new Request(`${base}/v1/tunnels/${tunnel}`, { method: 'DELETE', headers }),
        new Request(`${base}/v1/tunnels/${tunnel}/poll`, { method: 'GET', headers }),
      ]) {
        const response = await worker.fetch(request, env);
        expect(response.status).toBe(404);
      }
      expect(calls).toHaveLength(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects callers that do not present the tracked public bootstrap key and fails closed without the server-side runtime key', async () => {
    const worker = (await import(`${pathToFileURL(workerPath).href}?t=${Date.now()}-auth`)).default as {
      fetch(request: Request, env: Record<string, string>): Promise<Response>;
    };
    const base = bootstrap.controlPlaneBaseUrl!;
    const tunnel = bootstrap.tunnelId!;

    const missingPublicKey = await worker.fetch(new Request(`${base}/v1/tunnels/${tunnel}`), {
      OPENAI_TUNNEL_RUNTIME_KEY: 'server-side-secret-for-test-only',
    });
    expect(missingPublicKey.status).toBe(401);

    const missingRuntimeSecret = await worker.fetch(new Request(`${base}/v1/tunnels/${tunnel}`, {
      headers: { authorization: `Bearer ${bootstrap.publicRuntimeKey}` },
    }), {});
    expect(missingRuntimeSecret.status).toBe(503);
  });
});
