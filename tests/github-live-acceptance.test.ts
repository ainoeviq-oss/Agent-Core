import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runGitHubLiveAcceptance } from '../src/github/live-acceptance.js';

const TOKEN_PATH = 'E:\\Projects\\Agent-Core\\secrets\\github\\gh-token.txt';
const PACKAGES_PATH = 'E:\\Projects\\Agent-Core\\secrets\\github\\packages-token.txt';

function apiResult(data: unknown, status = 200) {
  return { ok: true, status, method: 'GET', endpoint: '/fixture', headers: {}, data };
}

describe('GitHub live acceptance harness', () => {
  it('does nothing until explicit opt-in is present', async () => {
    const factory = vi.fn();
    const result = await runGitHubLiveAcceptance({
      env: {},
      baseDir: path.resolve('.'),
      serviceFactory: factory as any,
    });
    expect(result).toMatchObject({
      schema: 'agent-core-github-live-acceptance/1',
      attempted: false,
      ok: false,
      reason: 'opt_in_required',
    });
    expect(factory).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('gh-token.txt');
    expect(JSON.stringify(result)).not.toContain('packages-token.txt');
  });

  it('uses the GitHub service boundaries and emits only bounded safe read-only evidence', async () => {
    const service = {
      status: vi.fn(async () => ({
        enabled: true,
        apiVersion: '2026-03-10',
        githubTokenConfigured: true,
        packagesTokenConfigured: true,
        githubTokenPath: TOKEN_PATH,
        packagesTokenPath: PACKAGES_PATH,
        gitAvailable: true,
        gitVersion: 'git version fixture',
      })),
      apiRequest: vi.fn(async () => apiResult({ login: 'rendevouz999', id: 123 })),
      repo: vi.fn(async () => apiResult({
        full_name: 'rendevouz999/Agent-Core', private: true, default_branch: 'main',
      })),
      git: {
        lsRemote: vi.fn(async () => ({
          exitCode: 0, timedOut: false, outputTruncated: false,
          stdout: `${'a'.repeat(40)}\tHEAD\n${'b'.repeat(40)}\trefs/heads/main\n`, stderr: '',
        })),
      },
      packages: {
        list: vi.fn(async () => apiResult([{ name: 'agent-core-plugin' }], 200)),
      },
    };
    const factory = vi.fn(() => service as any);
    const result = await runGitHubLiveAcceptance({
      env: { AGENT_CORE_GITHUB_LIVE_ACCEPTANCE: '1' },
      baseDir: path.resolve('.'),
      serviceFactory: factory,
    });

    expect(factory).toHaveBeenCalledTimes(1);
    expect(service.apiRequest).toHaveBeenCalledWith({ method: 'GET', endpoint: '/user' });
    expect(service.repo).toHaveBeenCalledWith({ operation: 'get', owner: 'rendevouz999', repo: 'Agent-Core' });
    expect(service.git.lsRemote).toHaveBeenCalledWith({
      owner: 'rendevouz999', repo: 'Agent-Core', refs: ['HEAD', 'refs/heads/main'],
    });
    expect(service.packages.list).toHaveBeenCalledWith({ packageType: 'npm', perPage: 5, page: 1 });
    expect(result).toMatchObject({
      attempted: true,
      ok: true,
      target: { owner: 'rendevouz999', repo: 'Agent-Core' },
      credentials: { githubConfigured: true, packagesConfigured: true },
      probes: {
        identity: { ok: true, status: 200, login: 'rendevouz999' },
        repository: { ok: true, status: 200, fullName: 'rendevouz999/Agent-Core', private: true, defaultBranch: 'main' },
        gitLsRemote: { ok: true, refCount: 2, headSha: 'aaaaaaaaaaaa' },
        packages: { ok: true, status: 200, packageType: 'npm', count: 1 },
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(TOKEN_PATH);
    expect(serialized).not.toContain(PACKAGES_PATH);
    expect(serialized).not.toContain('git version fixture');
    expect(serialized).not.toContain('refs/heads/main');
    expect(serialized).not.toContain('stdout');
  });

  it('scrubs credential-like values and local secret paths from safe failure evidence', async () => {
    const leaked = 'github_pat_FAKE_SENTINEL_12345678901234567890';
    const service = {
      status: vi.fn(async () => ({
        enabled: true, apiVersion: '2026-03-10', githubTokenConfigured: true,
        packagesTokenConfigured: true, githubTokenPath: TOKEN_PATH, packagesTokenPath: PACKAGES_PATH,
        gitAvailable: true,
      })),
      apiRequest: vi.fn(async () => { throw Object.assign(new Error(`auth ${leaked} ${TOKEN_PATH}`), { code: 'GITHUB_API_AUTH_FAILED' }); }),
      repo: vi.fn(async () => apiResult({ full_name: 'rendevouz999/Agent-Core', private: true, default_branch: 'main' })),
      git: { lsRemote: vi.fn(async () => ({ exitCode: 0, timedOut: false, outputTruncated: false, stdout: `${'a'.repeat(40)}\tHEAD\n`, stderr: '' })) },
      packages: { list: vi.fn(async () => apiResult([], 200)) },
    };
    const result = await runGitHubLiveAcceptance({
      env: { AGENT_CORE_GITHUB_LIVE_ACCEPTANCE: '1' },
      baseDir: path.resolve('.'),
      serviceFactory: () => service as any,
    });
    const serialized = JSON.stringify(result);
    expect(result.ok).toBe(false);
    expect(serialized).not.toContain(leaked);
    expect(serialized).not.toContain(TOKEN_PATH);
    expect(serialized).toContain('GITHUB_API_AUTH_FAILED');
  });

  it('keeps the executable wrapper on the production harness instead of curl, gh auth, or direct secret reads', async () => {
    const script = await readFile(path.resolve('scripts', 'github-live-acceptance.mjs'), 'utf8');
    expect(script).toContain("../dist/github/live-acceptance.js");
    expect(script).not.toMatch(/\bcurl\b/i);
    expect(script).not.toMatch(/\bgh\s+auth\b/i);
    expect(script).not.toContain('readFile(');
  });

  it('ships canonical operator documentation and an explicit npm acceptance command', async () => {
    const [packageJson, docsIndex, rootReadme, releaseBuilder, githubDoc] = await Promise.all([
      readFile(path.resolve('package.json'), 'utf8'),
      readFile(path.resolve('docs', 'README.md'), 'utf8'),
      readFile(path.resolve('README.md'), 'utf8'),
      readFile(path.resolve('scripts', 'release', 'release-contract.mjs'), 'utf8'),
      readFile(path.resolve('docs', 'github.md'), 'utf8'),
    ]);
    const packageMeta = JSON.parse(packageJson) as { scripts?: Record<string, string> };
    expect(packageMeta.scripts?.['acceptance:github']).toContain('github-live-acceptance.mjs');
    expect(docsIndex).toContain('[`github.md`](github.md)');
    expect(rootReadme).toContain('[`docs/github.md`](docs/github.md)');
    expect(releaseBuilder).toContain("'docs/github.md'");
    expect(githubDoc).toContain('2026-03-10');
    expect(githubDoc).toContain('read:packages');
    expect(githubDoc).toContain('personal access token (classic)');
    expect(githubDoc).toContain('AGENT_CORE_GITHUB_LIVE_ACCEPTANCE');
    expect(githubDoc).not.toContain('github_pat_');
  });
});
