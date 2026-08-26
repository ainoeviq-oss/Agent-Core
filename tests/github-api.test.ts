import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { GitHubApiService } from '../src/github/api-service.js';
import { GitHubCredentialProvider } from '../src/github/credentials.js';

const roots: string[] = [];
const TOKEN = 'SENTINEL_GITHUB_API_TOKEN_DO_NOT_LEAK';

async function setup(fetchImpl: typeof fetch) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-core-github-api-'));
  roots.push(root);
  const config = loadConfig({}, root).github;
  await mkdir(path.dirname(config.tokenFile), { recursive: true });
  await writeFile(config.tokenFile, TOKEN, 'utf8');
  await writeFile(config.packagesTokenFile, 'PACKAGES_SENTINEL', 'utf8');
  const credentials = new GitHubCredentialProvider(config);
  return { config, credentials, api: new GitHubApiService(config, credentials, fetchImpl) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('GitHubApiService', () => {
  it('builds authenticated versioned requests for relative endpoints', async () => {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      seenUrl = String(input);
      seenInit = init;
      return new Response(JSON.stringify({ login: 'safe-user' }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-github-request-id': 'REQ-1' },
      });
    };
    const { api } = await setup(fetchImpl);

    const result = await api.request({ method: 'GET', endpoint: '/user' });
    expect(seenUrl).toBe('https://api.github.com/user');
    expect(seenInit?.redirect).toBe('manual');
    const headers = new Headers(seenInit?.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(headers.get('accept')).toBe('application/vnd.github+json');
    expect(headers.get('x-github-api-version')).toBe('2026-03-10');
    expect(headers.get('user-agent')).toBe('Agent-Core/0.5.0');
    expect(result).toMatchObject({ ok: true, status: 200, method: 'GET', endpoint: '/user' });
    expect(result.data).toEqual({ login: 'safe-user' });
    expect(result.headers.requestId).toBe('REQ-1');
  });

  it('accepts same-origin absolute endpoints and serializes bounded query values', async () => {
    let seenUrl = '';
    const fetchImpl: typeof fetch = async (input) => {
      seenUrl = String(input);
      return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
    };
    const { api } = await setup(fetchImpl);
    await api.request({
      method: 'GET',
      endpoint: 'https://api.github.com/repos/rendevouz999/Agent-Core',
      query: { per_page: 30, archived: false, ignored: null },
    });
    expect(seenUrl).toBe('https://api.github.com/repos/rendevouz999/Agent-Core?per_page=30&archived=false');
  });

  it('rejects cross-origin endpoints before fetch', async () => {
    let called = false;
    const fetchImpl: typeof fetch = async () => { called = true; return new Response('{}'); };
    const { api } = await setup(fetchImpl);
    await expect(api.request({ method: 'GET', endpoint: 'https://evil.example/user' }))
      .rejects.toMatchObject({ code: 'GITHUB_ENDPOINT_NOT_ALLOWED' });
    expect(called).toBe(false);
  });

  it('rejects credential-bearing caller headers before fetch', async () => {
    let called = false;
    const fetchImpl: typeof fetch = async () => { called = true; return new Response('{}'); };
    const { api } = await setup(fetchImpl);
    for (const name of ['Authorization', 'Proxy-Authorization', 'Cookie', 'Set-Cookie']) {
      await expect(api.request({ method: 'GET', endpoint: '/user', headers: { [name]: 'bad' } }))
        .rejects.toMatchObject({ code: 'GITHUB_ENDPOINT_NOT_ALLOWED' });
    }
    expect(called).toBe(false);
  });

  it('serializes JSON request bodies exactly once', async () => {
    let body: BodyInit | null | undefined;
    let headers = new Headers();
    const fetchImpl: typeof fetch = async (_input, init) => {
      body = init?.body;
      headers = new Headers(init?.headers);
      return new Response(null, { status: 204 });
    };
    const { api } = await setup(fetchImpl);
    const result = await api.request({ method: 'POST', endpoint: '/repos/a/b/issues', body: { title: 'Hello' } });
    expect(body).toBe(JSON.stringify({ title: 'Hello' }));
    expect(headers.get('content-type')).toBe('application/json');
    expect(result.data).toBeNull();
    expect(result.status).toBe(204);
  });

  it('normalizes rate limit and pagination metadata', async () => {
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify([{ id: 1 }]), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '4999',
        'x-ratelimit-reset': '1787729999',
        link: '<https://api.github.com/user/repos?page=2>; rel="next", <https://api.github.com/user/repos?page=9>; rel="last"',
      },
    });
    const { api } = await setup(fetchImpl);
    const result = await api.request({ method: 'GET', endpoint: '/user/repos' });
    expect(result.headers).toMatchObject({
      rateLimitLimit: 5000,
      rateLimitRemaining: 4999,
      rateLimitReset: 1787729999,
      next: 'https://api.github.com/user/repos?page=2',
    });
  });

  it.each([
    [401, {}, 'GITHUB_API_AUTH_FAILED'],
    [403, { 'x-ratelimit-remaining': '2' }, 'GITHUB_API_FORBIDDEN'],
    [404, {}, 'GITHUB_API_NOT_FOUND'],
    [422, {}, 'GITHUB_API_VALIDATION_FAILED'],
    [429, {}, 'GITHUB_API_RATE_LIMITED'],
    [500, {}, 'GITHUB_API_ERROR'],
  ] as const)('classifies HTTP %s safely', async (status, extraHeaders, code) => {
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ message: `failure ${TOKEN}` }), {
      status,
      headers: { 'content-type': 'application/json', ...extraHeaders },
    });
    const { api } = await setup(fetchImpl);
    const caught = await api.request({ method: 'GET', endpoint: '/user' }).catch((error) => error as Error & { code?: string });
    expect(caught).toMatchObject({ code });
    expect(caught.message).not.toContain(TOKEN);
  });

  it('classifies exhausted 403 responses as rate limited', async () => {
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ message: 'rate limited' }), {
      status: 403,
      headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '0' },
    });
    const { api } = await setup(fetchImpl);
    await expect(api.request({ method: 'GET', endpoint: '/user' }))
      .rejects.toMatchObject({ code: 'GITHUB_API_RATE_LIMITED' });
  });

  it('redacts token values from thrown network errors', async () => {
    const fetchImpl: typeof fetch = async () => { throw new Error(`socket failed with ${TOKEN}`); };
    const { api } = await setup(fetchImpl);
    const caught = await api.request({ method: 'GET', endpoint: '/user' }).catch((error) => error as Error & { code?: string });
    expect(caught.code).toBe('GITHUB_API_ERROR');
    expect(caught.message).not.toContain(TOKEN);
    expect(caught.message).toContain('[REDACTED_GITHUB_CREDENTIAL]');
  });

  it('blocks redirects to a different origin without forwarding authorization', async () => {
    const fetchImpl: typeof fetch = async () => new Response('', {
      status: 302,
      headers: { location: 'https://evil.example/capture' },
    });
    const { api } = await setup(fetchImpl);
    await expect(api.request({ method: 'GET', endpoint: '/user' }))
      .rejects.toMatchObject({ code: 'GITHUB_ENDPOINT_NOT_ALLOWED' });
  });
});
