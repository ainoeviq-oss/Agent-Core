import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { GitHubCredentialProvider } from '../src/github/credentials.js';
import { GitHubGitService } from '../src/github/git-service.js';
import type { SpawnRequest, SpawnResult } from '../src/github/process.js';
import { GITHUB_DESTRUCTIVE_CONFIRMATION } from '../src/github/safety.js';
import { WorkspacePolicy } from '../src/runtime/workspace.js';

const roots: string[] = [];
const TOKEN = 'SENTINEL_GIT_TOKEN_DO_NOT_LEAK';

const okResult = (stdout = ''): SpawnResult => ({
  exitCode: 0,
  stdout,
  stderr: '',
  timedOut: false,
  outputTruncated: false,
});

async function setup(runner: (request: SpawnRequest) => Promise<SpawnResult>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-core-github-git-'));
  roots.push(root);
  const config = loadConfig({}, root).github;
  await mkdir(path.dirname(config.tokenFile), { recursive: true });
  await writeFile(config.tokenFile, TOKEN, 'utf8');
  const credentials = new GitHubCredentialProvider(config);
  const workspace = new WorkspacePolicy([root]);
  const service = new GitHubGitService(config, credentials, workspace, runner);
  return { root, config, credentials, workspace, service };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('GitHubGitService', () => {
  it('injects credentials ephemerally for ls-remote without placing the token in args or helper source', async () => {
    let captured: SpawnRequest | undefined;
    let helperSource = '';
    const { service } = await setup(async (request) => {
      captured = request;
      const helperPath = request.env?.GIT_ASKPASS;
      expect(helperPath).toBeTruthy();
      helperSource = await readFile(String(helperPath), 'utf8');
      return okResult('abc123\trefs/heads/main\n');
    });

    const result = await service.lsRemote({ owner: 'rendevouz999', repo: 'Agent-Core' });
    expect(result.stdout).toContain('refs/heads/main');
    expect(captured?.executable.toLowerCase()).toContain('git');
    expect(captured?.args).toEqual(['ls-remote', 'https://github.com/rendevouz999/Agent-Core.git']);
    expect(JSON.stringify(captured?.args)).not.toContain(TOKEN);
    expect(captured?.env?.AGENT_CORE_GITHUB_ASKPASS_TOKEN).toBe(TOKEN);
    expect(captured?.env?.GIT_TERMINAL_PROMPT).toBe('0');
    expect(captured?.env?.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(helperSource).toContain('AGENT_CORE_GITHUB_ASKPASS_TOKEN');
    expect(helperSource).not.toContain(TOKEN);
    await expect(access(String(captured?.env?.GIT_ASKPASS))).rejects.toThrow();
  });

  it('uses a canonical token-free HTTPS GitHub remote for clone', async () => {
    let captured: SpawnRequest | undefined;
    const { root, service } = await setup(async (request) => {
      captured = request;
      return okResult();
    });
    const destination = path.join(root, 'new-repo');
    await service.clone({ owner: 'octo', repo: 'demo', destination });
    expect(captured?.args).toEqual(['clone', 'https://github.com/octo/demo.git', destination]);
    expect(JSON.stringify(captured?.args)).not.toContain(TOKEN);
  });

  it('rejects clone destinations outside the workspace before runner invocation', async () => {
    let calls = 0;
    const { service } = await setup(async () => { calls += 1; return okResult(); });
    const outside = path.resolve(os.tmpdir(), `outside-agent-core-${Date.now()}`);
    await expect(service.clone({ owner: 'octo', repo: 'demo', destination: outside })).rejects.toThrow('outside allowed roots');
    expect(calls).toBe(0);
  });

  it('requires exact destructive confirmation before force push', async () => {
    let calls = 0;
    const { root, service } = await setup(async () => { calls += 1; return okResult(); });
    const repoDir = path.join(root, 'repo');
    await mkdir(repoDir);

    await expect(service.push({ cwd: repoDir, remote: 'origin', refspec: 'main', force: true }))
      .rejects.toMatchObject({ code: 'GITHUB_DESTRUCTIVE_CONFIRMATION_REQUIRED' });
    expect(calls).toBe(0);

    await service.push({
      cwd: repoDir,
      remote: 'origin',
      refspec: 'main',
      force: true,
      destructiveConfirmation: GITHUB_DESTRUCTIVE_CONFIRMATION,
    });
    expect(calls).toBe(1);
  });

  it('rejects unsafe remote-set-url values before invoking git', async () => {
    let calls = 0;
    const { root, service } = await setup(async () => { calls += 1; return okResult(); });
    const repoDir = path.join(root, 'repo');
    await mkdir(repoDir);

    for (const url of [
      `https://${TOKEN}@github.com/octo/demo.git`,
      'http://github.com/octo/demo.git',
      'ssh://git@github.com/octo/demo.git',
      'https://evil.example/octo/demo.git',
    ]) {
      await expect(service.remoteSetUrl({ cwd: repoDir, remote: 'origin', url }))
        .rejects.toMatchObject({ code: 'GITHUB_ENDPOINT_NOT_ALLOWED' });
    }
    expect(calls).toBe(0);
  });

  it('keeps canonical remote-set-url values token free', async () => {
    let captured: SpawnRequest | undefined;
    const { root, service } = await setup(async (request) => { captured = request; return okResult(); });
    const repoDir = path.join(root, 'repo');
    await mkdir(repoDir);
    await service.remoteSetUrl({ cwd: repoDir, remote: 'origin', url: 'https://github.com/octo/demo.git' });
    expect(captured?.args).toEqual(['remote', 'set-url', 'origin', 'https://github.com/octo/demo.git']);
    expect(captured?.env?.AGENT_CORE_GITHUB_ASKPASS_TOKEN).toBeUndefined();
  });

  it.each([
    ['remote: Invalid username or password.', 'GITHUB_GIT_AUTH_FAILED'],
    ['! [rejected] main -> main (non-fast-forward)', 'GITHUB_GIT_NON_FAST_FORWARD'],
    ['CONFLICT (content): Merge conflict in src/index.ts', 'GITHUB_GIT_CONFLICT'],
    ['fatal: unknown failure', 'GITHUB_GIT_FAILED'],
  ] as const)('classifies git stderr as %s -> %s', async (stderr, code) => {
    const { service } = await setup(async () => ({
      exitCode: 1,
      stdout: '',
      stderr,
      timedOut: false,
      outputTruncated: false,
    }));
    const caught = await service.lsRemote({ owner: 'octo', repo: 'demo' }).catch((error) => error as Error & { code?: string });
    expect(caught.code).toBe(code);
  });

  it('redacts token values from process output and failure errors', async () => {
    const { service } = await setup(async () => ({
      exitCode: 1,
      stdout: `stdout ${TOKEN}`,
      stderr: `fatal auth ${TOKEN}`,
      timedOut: false,
      outputTruncated: false,
    }));
    const caught = await service.lsRemote({ owner: 'octo', repo: 'demo' }).catch((error) => error as Error);
    expect(caught.message).not.toContain(TOKEN);
    expect(caught.message).toContain('[REDACTED_GITHUB_CREDENTIAL]');
  });

  it('removes the transient askpass helper even when the runner throws', async () => {
    let helperPath = '';
    const { service } = await setup(async (request) => {
      helperPath = String(request.env?.GIT_ASKPASS ?? '');
      await access(helperPath);
      throw new Error(`runner exploded ${TOKEN}`);
    });
    const caught = await service.lsRemote({ owner: 'octo', repo: 'demo' }).catch((error) => error as Error);
    expect(caught.message).not.toContain(TOKEN);
    expect(helperPath).toBeTruthy();
    await expect(access(helperPath)).rejects.toThrow();
  });

  it('reports git availability through a bounded --version probe', async () => {
    let captured: SpawnRequest | undefined;
    const { service } = await setup(async (request) => { captured = request; return okResult('git version 2.55.0.windows.5\n'); });
    await expect(service.status()).resolves.toEqual({ gitAvailable: true, gitVersion: 'git version 2.55.0.windows.5' });
    expect(captured?.executable).toBe(process.platform === 'win32' ? 'git.exe' : 'git');
    expect(captured?.args).toEqual(['--version']);
    expect(captured?.env?.AGENT_CORE_GITHUB_ASKPASS_TOKEN).toBeUndefined();
  });
});
