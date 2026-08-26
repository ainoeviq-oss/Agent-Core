import path from 'node:path';
import { loadConfig, type GitHubConfig } from '../config.js';
import { WorkspacePolicy } from '../runtime/workspace.js';
import type { GitHubApiResult } from './api-service.js';
import { GitHubService } from './service.js';

export interface GitHubLiveAcceptanceResult {
  schema: 'agent-core-github-live-acceptance/1';
  attempted: boolean;
  ok: boolean;
  reason?: 'opt_in_required';
  target?: { owner: string; repo: string };
  apiVersion?: string;
  credentials?: { githubConfigured: boolean; packagesConfigured: boolean };
  probes?: {
    identity: GitHubLiveProbe;
    repository: GitHubLiveProbe;
    gitLsRemote: GitHubLiveProbe;
    packages: GitHubLiveProbe;
  };
}

export type GitHubLiveProbe = {
  ok: boolean;
  status?: number;
  code?: string;
  message?: string;
  login?: string;
  fullName?: string;
  private?: boolean;
  defaultBranch?: string;
  refCount?: number;
  headSha?: string;
  packageType?: string;
  count?: number;
};

export interface GitHubLiveAcceptanceOptions {
  env?: Record<string, string | undefined>;
  baseDir?: string;
  serviceFactory?: (config: GitHubConfig, workspace: WorkspacePolicy) => GitHubService;
}

function configuredTarget(value: string | undefined, fallback: string): string {
  const normalized = value?.trim() || fallback;
  if (!/^[A-Za-z0-9_.-]+$/.test(normalized)) throw new Error('GITHUB_LIVE_ACCEPTANCE_TARGET_INVALID');
  return normalized;
}

function asApiResult(value: unknown): GitHubApiResult {
  if (!value || typeof value !== 'object' || !('status' in value) || !('data' in value)) {
    throw new Error('GITHUB_LIVE_ACCEPTANCE_RESULT_INVALID');
  }
  return value as GitHubApiResult;
}

function objectData(result: GitHubApiResult): Record<string, unknown> {
  return result.data && typeof result.data === 'object' && !Array.isArray(result.data)
    ? result.data as Record<string, unknown>
    : {};
}

function safeString(value: unknown, max = 200): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, max) : undefined;
}

function scrubText(value: string, config: GitHubConfig): string {
  let output = value;
  for (const secretPath of [config.tokenFile, config.packagesTokenFile]) {
    if (secretPath) output = output.split(secretPath).join('[REDACTED_GITHUB_CREDENTIAL_PATH]');
  }
  output = output
    .replace(/github_pat_[A-Za-z0-9_]+/g, '[REDACTED_GITHUB_CREDENTIAL]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]+\b/g, '[REDACTED_GITHUB_CREDENTIAL]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED_GITHUB_CREDENTIAL]')
    .replace(/Authorization\s*:\s*[^\r\n]+/gi, 'Authorization: [REDACTED_GITHUB_CREDENTIAL]');
  return output.slice(0, 500);
}

function failure(error: unknown, config: GitHubConfig): GitHubLiveProbe {
  const candidate = error as { code?: unknown; message?: unknown; name?: unknown };
  const code = typeof candidate?.code === 'string'
    ? candidate.code
    : typeof candidate?.name === 'string'
      ? candidate.name
      : 'ERROR';
  const raw = typeof candidate?.message === 'string' ? candidate.message : String(error);
  return { ok: false, code, message: scrubText(raw, config) };
}

function parseGitProbe(stdout: string): GitHubLiveProbe {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let headSha: string | undefined;
  for (const line of lines) {
    const [sha, ref] = line.split(/\s+/, 2);
    if (ref === 'HEAD' && /^[a-f0-9]{40}$/i.test(sha ?? '')) {
      headSha = sha!.slice(0, 12).toLowerCase();
      break;
    }
  }
  return { ok: true, refCount: lines.length, ...(headSha ? { headSha } : {}) };
}

export async function runGitHubLiveAcceptance(
  options: GitHubLiveAcceptanceOptions = {},
): Promise<GitHubLiveAcceptanceResult> {
  const env = options.env ?? process.env;
  if (env.AGENT_CORE_GITHUB_LIVE_ACCEPTANCE !== '1') {
    return {
      schema: 'agent-core-github-live-acceptance/1',
      attempted: false,
      ok: false,
      reason: 'opt_in_required',
    };
  }

  const baseDir = path.resolve(options.baseDir ?? process.cwd());
  const owner = configuredTarget(env.AGENT_CORE_GITHUB_ACCEPTANCE_OWNER, 'rendevouz999');
  const repo = configuredTarget(env.AGENT_CORE_GITHUB_ACCEPTANCE_REPO, 'Agent-Core');
  const config = loadConfig(env, baseDir).github;
  const workspace = new WorkspacePolicy([baseDir]);
  const service = (options.serviceFactory ?? ((githubConfig, policy) => new GitHubService(githubConfig, policy)))(config, workspace);

  let githubConfigured = false;
  let packagesConfigured = false;
  try {
    const status = await service.status();
    githubConfigured = Boolean(status.githubTokenConfigured);
    packagesConfigured = Boolean(status.packagesTokenConfigured);
  } catch {
    // Individual probes below return the precise safe failure without exposing status internals.
  }

  let identity: GitHubLiveProbe;
  try {
    const result = await service.apiRequest({ method: 'GET', endpoint: '/user' });
    const data = objectData(result);
    identity = {
      ok: true,
      status: result.status,
      ...(safeString(data.login, 100) ? { login: safeString(data.login, 100) } : {}),
    };
  } catch (error) {
    identity = failure(error, config);
  }

  let repository: GitHubLiveProbe;
  let defaultBranch = 'main';
  try {
    const result = asApiResult(await service.repo({ operation: 'get', owner, repo }));
    const data = objectData(result);
    defaultBranch = safeString(data.default_branch, 200) ?? defaultBranch;
    repository = {
      ok: true,
      status: result.status,
      ...(safeString(data.full_name, 300) ? { fullName: safeString(data.full_name, 300) } : {}),
      ...(typeof data.private === 'boolean' ? { private: data.private } : {}),
      defaultBranch,
    };
  } catch (error) {
    repository = failure(error, config);
  }

  let gitLsRemote: GitHubLiveProbe;
  try {
    const result = await service.git.lsRemote({
      owner,
      repo,
      refs: ['HEAD', `refs/heads/${defaultBranch}`],
    });
    gitLsRemote = parseGitProbe(result.stdout);
  } catch (error) {
    gitLsRemote = failure(error, config);
  }

  let packages: GitHubLiveProbe;
  try {
    const result = await service.packages.list({ packageType: 'npm', perPage: 5, page: 1 });
    packages = {
      ok: true,
      status: result.status,
      packageType: 'npm',
      count: Array.isArray(result.data) ? result.data.length : 0,
    };
  } catch (error) {
    packages = { ...failure(error, config), packageType: 'npm' };
  }

  const probes = { identity, repository, gitLsRemote, packages };
  return {
    schema: 'agent-core-github-live-acceptance/1',
    attempted: true,
    ok: githubConfigured && packagesConfigured && Object.values(probes).every((probe) => probe.ok),
    target: { owner, repo },
    apiVersion: config.apiVersion,
    credentials: { githubConfigured, packagesConfigured },
    probes,
  };
}
