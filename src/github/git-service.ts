import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { GitHubConfig } from '../config.js';
import type { WorkspacePolicy } from '../runtime/workspace.js';
import type { GitHubCredentialProvider } from './credentials.js';
import { GitHubFabricError } from './errors.js';
import { runBoundedProcess, type ProcessRunner, type SpawnResult } from './process.js';
import { assertDestructiveConfirmation } from './safety.js';

const REPO_PART = /^[A-Za-z0-9_.-]+$/;

function assertRepoPart(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized === '.' || normalized === '..' || !REPO_PART.test(normalized)) {
    throw new GitHubFabricError('GITHUB_ENDPOINT_NOT_ALLOWED', `Invalid GitHub ${label}`);
  }
  return normalized;
}

function canonicalRemote(owner: string, repo: string): string {
  return `https://github.com/${assertRepoPart(owner, 'owner')}/${assertRepoPart(repo, 'repository')}.git`;
}

function assertSafeGitHubRemote(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new GitHubFabricError('GITHUB_ENDPOINT_NOT_ALLOWED', 'Git remote URL must be a valid HTTPS GitHub URL'); }
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== 'github.com' ||
    url.username ||
    url.password ||
    !url.pathname.endsWith('.git')
  ) {
    throw new GitHubFabricError('GITHUB_ENDPOINT_NOT_ALLOWED', 'Git remote URL must be a token-free https://github.com/...git URL');
  }
  return url.href;
}

function gitErrorCode(stderr: string): 'GITHUB_GIT_AUTH_FAILED' | 'GITHUB_GIT_NON_FAST_FORWARD' | 'GITHUB_GIT_CONFLICT' | 'GITHUB_GIT_FAILED' {
  const normalized = stderr.toLowerCase();
  if (/invalid username|authentication failed|could not read username|terminal prompts disabled|access denied|repository not found/.test(normalized)) {
    return 'GITHUB_GIT_AUTH_FAILED';
  }
  if (/non-fast-forward|fetch first|failed to push some refs/.test(normalized)) return 'GITHUB_GIT_NON_FAST_FORWARD';
  if (/\bconflict\b|automatic merge failed|unmerged files/.test(normalized)) return 'GITHUB_GIT_CONFLICT';
  return 'GITHUB_GIT_FAILED';
}

function cleanOutput(result: SpawnResult, credentials: GitHubCredentialProvider, secrets: string[] = []): SpawnResult {
  return {
    ...result,
    stdout: credentials.redact(result.stdout, secrets),
    stderr: credentials.redact(result.stderr, secrets),
  };
}

export class GitHubGitService {
  private readonly gitExecutable = 'git.exe';
  private readonly runtimeRoot: string;

  constructor(
    private readonly config: GitHubConfig,
    private readonly credentials: GitHubCredentialProvider,
    private readonly workspace: WorkspacePolicy,
    private readonly runner: ProcessRunner = runBoundedProcess,
  ) {
    this.runtimeRoot = path.join(this.workspace.roots[0]!, 'runtime', 'github');
  }

  async status(): Promise<{ gitAvailable: boolean; gitVersion?: string }> {
    try {
      const result = await this.runner({
        executable: this.gitExecutable,
        args: ['--version'],
        cwd: this.workspace.roots[0]!,
        timeoutMs: Math.min(this.config.gitTimeoutMs, 10_000),
        env: { ...process.env },
      });
      if (result.exitCode !== 0) return { gitAvailable: false };
      return { gitAvailable: true, gitVersion: result.stdout.trim() };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { gitAvailable: false };
      return { gitAvailable: false };
    }
  }

  async clone(input: { owner: string; repo: string; destination: string }): Promise<SpawnResult> {
    const destination = await this.workspace.resolveTarget(input.destination);
    const cwd = await this.workspace.resolveExisting(path.dirname(destination));
    return this.runAuthenticated(['clone', canonicalRemote(input.owner, input.repo), destination], cwd);
  }

  async fetch(input: { cwd: string; remote?: string; refspec?: string }): Promise<SpawnResult> {
    const cwd = await this.workspace.resolveExisting(input.cwd);
    const args = ['fetch'];
    if (input.remote?.trim()) args.push(input.remote.trim());
    if (input.refspec?.trim()) args.push(input.refspec.trim());
    return this.runAuthenticated(args, cwd);
  }

  async pull(input: { cwd: string; remote?: string; ref?: string }): Promise<SpawnResult> {
    const cwd = await this.workspace.resolveExisting(input.cwd);
    const args = ['pull'];
    if (input.remote?.trim()) args.push(input.remote.trim());
    if (input.ref?.trim()) args.push(input.ref.trim());
    return this.runAuthenticated(args, cwd);
  }

  async push(input: {
    cwd: string;
    remote?: string;
    refspec?: string;
    force?: boolean;
    destructiveConfirmation?: string;
  }): Promise<SpawnResult> {
    assertDestructiveConfirmation(Boolean(input.force), input.destructiveConfirmation);
    const cwd = await this.workspace.resolveExisting(input.cwd);
    const args = ['push'];
    if (input.force) args.push('--force');
    if (input.remote?.trim()) args.push(input.remote.trim());
    if (input.refspec?.trim()) args.push(input.refspec.trim());
    return this.runAuthenticated(args, cwd);
  }

  async lsRemote(input: { owner: string; repo: string; refs?: string[] }): Promise<SpawnResult> {
    const args = ['ls-remote', canonicalRemote(input.owner, input.repo)];
    for (const ref of input.refs ?? []) {
      const trimmed = ref.trim();
      if (trimmed) args.push(trimmed);
    }
    return this.runAuthenticated(args, await this.workspace.resolveExisting(this.workspace.roots[0]!));
  }

  async remoteGetUrl(input: { cwd: string; remote?: string }): Promise<SpawnResult> {
    const cwd = await this.workspace.resolveExisting(input.cwd);
    return this.runLocal(['remote', 'get-url', input.remote?.trim() || 'origin'], cwd);
  }

  async remoteSetUrl(input: { cwd: string; remote?: string; url: string }): Promise<SpawnResult> {
    const safeUrl = assertSafeGitHubRemote(input.url);
    const cwd = await this.workspace.resolveExisting(input.cwd);
    return this.runLocal(['remote', 'set-url', input.remote?.trim() || 'origin', safeUrl], cwd);
  }

  private async runLocal(args: string[], cwd: string): Promise<SpawnResult> {
    let result: SpawnResult;
    try {
      result = await this.runner({
        executable: this.gitExecutable,
        args,
        cwd,
        timeoutMs: this.config.gitTimeoutMs,
        env: { ...process.env },
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new GitHubFabricError('GITHUB_GIT_NOT_FOUND', 'Git executable was not found');
      throw new GitHubFabricError('GITHUB_GIT_FAILED', error instanceof Error ? error.message : String(error));
    }
    if (result.exitCode !== 0 || result.timedOut) {
      throw new GitHubFabricError(gitErrorCode(result.stderr), result.stderr.trim() || 'Git command failed');
    }
    return result;
  }

  private async runAuthenticated(args: string[], cwd: string): Promise<SpawnResult> {
    const token = await this.credentials.read('github');
    const askpassDir = path.join(this.runtimeRoot, 'askpass');
    const askpassPath = path.join(askpassDir, `askpass-${randomUUID()}.cmd`);
    await mkdir(askpassDir, { recursive: true });
    await writeFile(
      askpassPath,
      '@echo off\r\nset "P=%~1"\r\necho %P% | findstr /I "username" >nul\r\nif %errorlevel%==0 (echo x-access-token) else (echo %AGENT_CORE_GITHUB_ASKPASS_TOKEN%)\r\n',
      { encoding: 'utf8', mode: 0o600 },
    );

    try {
      let result: SpawnResult;
      try {
        result = await this.runner({
          executable: this.gitExecutable,
          args,
          cwd,
          timeoutMs: this.config.gitTimeoutMs,
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: '0',
            GIT_ASKPASS: askpassPath,
            GIT_CONFIG_NOSYSTEM: '1',
            AGENT_CORE_GITHUB_ASKPASS_TOKEN: token,
          },
          redact: [token],
        });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') throw new GitHubFabricError('GITHUB_GIT_NOT_FOUND', 'Git executable was not found');
        const raw = error instanceof Error ? error.message : String(error);
        throw new GitHubFabricError('GITHUB_GIT_FAILED', this.credentials.redact(raw, [token]));
      }

      result = cleanOutput(result, this.credentials, [token]);
      if (result.exitCode !== 0 || result.timedOut) {
        const message = result.stderr.trim() || result.stdout.trim() || 'Git command failed';
        throw new GitHubFabricError(gitErrorCode(result.stderr), this.credentials.redact(message, [token]), {
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          outputTruncated: result.outputTruncated,
        });
      }
      return result;
    } finally {
      await rm(askpassPath, { force: true }).catch(() => undefined);
    }
  }
}
