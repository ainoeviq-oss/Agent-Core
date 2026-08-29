import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const deployModule = await import(pathToFileURL(path.join(pluginRoot, 'control-plane', 'deploy.mjs')).href) as {
  resolveAccountId(args: Record<string, unknown>): Promise<string>;
  deployControlPlaneWorker(args: Record<string, unknown>): Promise<void>;
  verifyControlPlaneHealth(args: Record<string, unknown>): Promise<void>;
};

describe('codespace control-plane deployment', () => {
  it('discovers exactly one Cloudflare account when an explicit account id is absent', async () => {
    const calls: string[] = [];
    const accountId = await deployModule.resolveAccountId({
      apiToken: 'cloudflare-test-token',
      fetchImpl: async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ success: true, result: [{ id: 'account-1' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    expect(accountId).toBe('account-1');
    expect(calls).toEqual(['https://api.cloudflare.com/client/v4/accounts']);
  });

  it('deploys worker source and stores the OpenAI runtime key only as a Cloudflare secret', async () => {
    const requests: Request[] = [];
    const runtimeKey = 'server-runtime-key-for-test-only';
    await deployModule.deployControlPlaneWorker({
      accountId: 'account-1',
      apiToken: 'cloudflare-test-token',
      runtimeKey,
      workerName: 'codespace-control-plane',
      workerSource: 'export default { fetch() { return new Response("ok") } };',
      fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(input instanceof Request ? input : new Request(input, init));
        return new Response(JSON.stringify({ success: true, result: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    expect(requests).toHaveLength(2);
    expect(requests[0].method).toBe('PUT');
    expect(requests[0].url).toContain('/workers/scripts/codespace-control-plane');
    expect(await requests[0].text()).not.toContain(runtimeKey);

    expect(requests[1].method).toBe('PUT');
    expect(requests[1].url).toContain('/workers/scripts/codespace-control-plane/secrets');
    const secretBody = JSON.parse(await requests[1].text());
    expect(secretBody.name).toBe('OPENAI_TUNNEL_RUNTIME_KEY');
    expect(secretBody.type).toBe('secret_text');
    expect(secretBody.text).toBe(runtimeKey);
  });

  it('requires deployed health to confirm the server-side runtime secret is configured', async () => {
    await expect(deployModule.verifyControlPlaneHealth({
      baseUrl: 'https://codespace-control-plane.example.workers.dev',
      attempts: 1,
      delayMs: 0,
      fetchImpl: async () => new Response(JSON.stringify({
        status: 'ok',
        service: 'codespace-control-plane',
        runtime_secret_configured: true,
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    })).resolves.toBeUndefined();

    await expect(deployModule.verifyControlPlaneHealth({
      baseUrl: 'https://codespace-control-plane.example.workers.dev',
      attempts: 1,
      delayMs: 0,
      fetchImpl: async () => new Response(JSON.stringify({
        status: 'ok',
        service: 'codespace-control-plane',
        runtime_secret_configured: false,
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    })).rejects.toThrow('CODESPACE_CONTROL_PLANE_HEALTH_FAILED');
  });
});
