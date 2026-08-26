import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { GitHubConfig } from '../config.js';
import type { WorkspacePolicy } from '../runtime/workspace.js';
import { GitHubApiService, type GitHubApiRequest, type GitHubApiResult } from './api-service.js';
import { GitHubCredentialProvider } from './credentials.js';
import { GitHubFabricError } from './errors.js';
import { GitHubGitService } from './git-service.js';
import { GitHubPackageService } from './package-service.js';
import type { ProcessRunner } from './process.js';
import { assertDestructiveConfirmation } from './safety.js';

function segment(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\r\n\0]/.test(normalized)) {
    throw new GitHubFabricError('GITHUB_ENDPOINT_NOT_ALLOWED', `Invalid GitHub ${label}`);
  }
  return encodeURIComponent(normalized);
}

function positiveId(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new GitHubFabricError('GITHUB_API_VALIDATION_FAILED', `${label} must be a positive integer`);
  return value;
}

function pageQuery(perPage?: number, page?: number): Record<string, number> {
  const per = perPage ?? 30;
  const current = page ?? 1;
  if (!Number.isSafeInteger(per) || per < 1 || per > 100) throw new GitHubFabricError('GITHUB_API_VALIDATION_FAILED', 'perPage must be between 1 and 100');
  if (!Number.isSafeInteger(current) || current < 1) throw new GitHubFabricError('GITHUB_API_VALIDATION_FAILED', 'page must be positive');
  return { per_page: per, page: current };
}

export interface GitHubRepoInput {
  operation: 'get' | 'list' | 'create' | 'update' | 'archive' | 'transfer' | 'delete';
  owner?: string;
  repo?: string;
  org?: string;
  body?: Record<string, unknown>;
  perPage?: number;
  page?: number;
  destructiveConfirmation?: string;
}

export interface GitHubIssueInput {
  operation: 'list' | 'get' | 'create' | 'update' | 'close' | 'comment';
  owner: string;
  repo: string;
  issueNumber?: number;
  body?: Record<string, unknown>;
  perPage?: number;
  page?: number;
}

export interface GitHubPrInput {
  operation: 'list' | 'get' | 'create' | 'update' | 'review' | 'merge' | 'comment';
  owner: string;
  repo: string;
  pullNumber?: number;
  body?: Record<string, unknown>;
  perPage?: number;
  page?: number;
  destructiveConfirmation?: string;
}

export interface GitHubActionsInput {
  operation: 'list_workflows' | 'list_runs' | 'get_run' | 'dispatch' | 'cancel' | 'rerun' | 'rerun_failed';
  owner: string;
  repo: string;
  workflow?: string;
  runId?: number;
  ref?: string;
  inputs?: Record<string, string>;
  perPage?: number;
  page?: number;
  destructiveConfirmation?: string;
}

export interface GitHubReleaseInput {
  operation: 'list' | 'get' | 'get_by_tag' | 'create' | 'edit' | 'delete' | 'upload_asset';
  owner: string;
  repo: string;
  releaseId?: number;
  tag?: string;
  body?: Record<string, unknown>;
  assetPath?: string;
  assetName?: string;
  contentType?: string;
  perPage?: number;
  page?: number;
  destructiveConfirmation?: string;
}

export interface GitHubServiceDependencies {
  fetchImpl?: typeof fetch;
  processRunner?: ProcessRunner;
}

export class GitHubService {
  readonly credentials: GitHubCredentialProvider;
  readonly api: GitHubApiService;
  readonly git: GitHubGitService;
  readonly packages: GitHubPackageService;
  private readonly fetchImpl: typeof fetch;

  constructor(
    readonly config: GitHubConfig,
    readonly workspace: WorkspacePolicy,
    dependencies: GitHubServiceDependencies = {},
  ) {
    this.credentials = new GitHubCredentialProvider(config);
    this.fetchImpl = dependencies.fetchImpl ?? fetch;
    this.api = new GitHubApiService(config, this.credentials, this.fetchImpl);
    this.git = new GitHubGitService(config, this.credentials, workspace, dependencies.processRunner);
    this.packages = new GitHubPackageService(config, this.credentials, workspace, this.api, dependencies.processRunner);
  }

  async status() {
    const [credentials, git] = await Promise.all([this.credentials.status(), this.git.status()]);
    return {
      enabled: this.config.enabled,
      apiBaseUrl: this.config.apiBaseUrl,
      apiVersion: this.config.apiVersion,
      ...credentials,
      ...git,
    };
  }

  apiRequest(input: GitHubApiRequest): Promise<GitHubApiResult> {
    return this.api.request(input);
  }

  async repo(input: GitHubRepoInput): Promise<unknown> {
    if (input.operation === 'list') {
      return this.api.request({ method: 'GET', endpoint: '/user/repos', query: pageQuery(input.perPage, input.page) });
    }
    if (input.operation === 'create') {
      if (!input.repo?.trim()) throw new GitHubFabricError('GITHUB_API_VALIDATION_FAILED', 'repo is required for create');
      const body = { ...(input.body ?? {}), name: input.repo.trim() };
      return this.api.request({
        method: 'POST',
        endpoint: input.org?.trim() ? `/orgs/${segment(input.org, 'organization')}/repos` : '/user/repos',
        body,
      });
    }
    const owner = segment(input.owner ?? '', 'owner');
    const repo = segment(input.repo ?? '', 'repository');
    const endpoint = `/repos/${owner}/${repo}`;
    if (input.operation === 'get') return this.api.request({ method: 'GET', endpoint });
    if (input.operation === 'update') return this.api.request({ method: 'PATCH', endpoint, body: input.body ?? {} });
    if (input.operation === 'archive') {
      assertDestructiveConfirmation(true, input.destructiveConfirmation);
      return this.api.request({ method: 'PATCH', endpoint, body: { ...(input.body ?? {}), archived: true } });
    }
    if (input.operation === 'transfer') {
      assertDestructiveConfirmation(true, input.destructiveConfirmation);
      return this.api.request({ method: 'POST', endpoint: `${endpoint}/transfer`, body: input.body ?? {} });
    }
    assertDestructiveConfirmation(true, input.destructiveConfirmation);
    return this.api.request({ method: 'DELETE', endpoint });
  }

  async issue(input: GitHubIssueInput): Promise<unknown> {
    const base = `/repos/${segment(input.owner, 'owner')}/${segment(input.repo, 'repository')}/issues`;
    if (input.operation === 'list') return this.api.request({ method: 'GET', endpoint: base, query: pageQuery(input.perPage, input.page) });
    if (input.operation === 'create') return this.api.request({ method: 'POST', endpoint: base, body: input.body ?? {} });
    const number = positiveId(input.issueNumber ?? 0, 'issueNumber');
    const endpoint = `${base}/${number}`;
    if (input.operation === 'get') return this.api.request({ method: 'GET', endpoint });
    if (input.operation === 'update') return this.api.request({ method: 'PATCH', endpoint, body: input.body ?? {} });
    if (input.operation === 'close') return this.api.request({ method: 'PATCH', endpoint, body: { ...(input.body ?? {}), state: 'closed' } });
    return this.api.request({ method: 'POST', endpoint: `${endpoint}/comments`, body: input.body ?? {} });
  }

  async pr(input: GitHubPrInput): Promise<unknown> {
    const repoBase = `/repos/${segment(input.owner, 'owner')}/${segment(input.repo, 'repository')}`;
    const pulls = `${repoBase}/pulls`;
    if (input.operation === 'list') return this.api.request({ method: 'GET', endpoint: pulls, query: pageQuery(input.perPage, input.page) });
    if (input.operation === 'create') return this.api.request({ method: 'POST', endpoint: pulls, body: input.body ?? {} });
    const number = positiveId(input.pullNumber ?? 0, 'pullNumber');
    const endpoint = `${pulls}/${number}`;
    if (input.operation === 'get') return this.api.request({ method: 'GET', endpoint });
    if (input.operation === 'update') return this.api.request({ method: 'PATCH', endpoint, body: input.body ?? {} });
    if (input.operation === 'review') return this.api.request({ method: 'POST', endpoint: `${endpoint}/reviews`, body: input.body ?? {} });
    if (input.operation === 'comment') return this.api.request({ method: 'POST', endpoint: `${repoBase}/issues/${number}/comments`, body: input.body ?? {} });
    assertDestructiveConfirmation(true, input.destructiveConfirmation);
    return this.api.request({ method: 'PUT', endpoint: `${endpoint}/merge`, body: input.body ?? {} });
  }

  async actions(input: GitHubActionsInput): Promise<unknown> {
    const base = `/repos/${segment(input.owner, 'owner')}/${segment(input.repo, 'repository')}/actions`;
    if (input.operation === 'list_workflows') return this.api.request({ method: 'GET', endpoint: `${base}/workflows`, query: pageQuery(input.perPage, input.page) });
    if (input.operation === 'list_runs') return this.api.request({ method: 'GET', endpoint: `${base}/runs`, query: pageQuery(input.perPage, input.page) });
    if (input.operation === 'get_run') return this.api.request({ method: 'GET', endpoint: `${base}/runs/${positiveId(input.runId ?? 0, 'runId')}` });
    if (input.operation === 'dispatch') {
      const workflow = segment(input.workflow ?? '', 'workflow');
      if (!input.ref?.trim()) throw new GitHubFabricError('GITHUB_API_VALIDATION_FAILED', 'ref is required for workflow dispatch');
      return this.api.request({ method: 'POST', endpoint: `${base}/workflows/${workflow}/dispatches`, body: { ref: input.ref.trim(), ...(input.inputs ? { inputs: input.inputs } : {}) } });
    }
    const runId = positiveId(input.runId ?? 0, 'runId');
    if (input.operation === 'cancel') {
      assertDestructiveConfirmation(true, input.destructiveConfirmation);
      return this.api.request({ method: 'POST', endpoint: `${base}/runs/${runId}/cancel` });
    }
    const suffix = input.operation === 'rerun_failed' ? 'rerun-failed-jobs' : 'rerun';
    return this.api.request({ method: 'POST', endpoint: `${base}/runs/${runId}/${suffix}` });
  }

  async release(input: GitHubReleaseInput): Promise<unknown> {
    const repoBase = `/repos/${segment(input.owner, 'owner')}/${segment(input.repo, 'repository')}/releases`;
    if (input.operation === 'list') return this.api.request({ method: 'GET', endpoint: repoBase, query: pageQuery(input.perPage, input.page) });
    if (input.operation === 'create') return this.api.request({ method: 'POST', endpoint: repoBase, body: input.body ?? {} });
    if (input.operation === 'get_by_tag') return this.api.request({ method: 'GET', endpoint: `${repoBase}/tags/${segment(input.tag ?? '', 'release tag')}` });
    const releaseId = positiveId(input.releaseId ?? 0, 'releaseId');
    const endpoint = `${repoBase}/${releaseId}`;
    if (input.operation === 'get') return this.api.request({ method: 'GET', endpoint });
    if (input.operation === 'edit') return this.api.request({ method: 'PATCH', endpoint, body: input.body ?? {} });
    if (input.operation === 'upload_asset') return this.uploadReleaseAsset(input, releaseId);
    assertDestructiveConfirmation(true, input.destructiveConfirmation);
    return this.api.request({ method: 'DELETE', endpoint });
  }

  private async uploadReleaseAsset(input: GitHubReleaseInput, releaseId: number): Promise<unknown> {
    if (!input.assetPath) throw new GitHubFabricError('GITHUB_API_VALIDATION_FAILED', 'assetPath is required');
    const assetPath = await this.workspace.resolveExisting(input.assetPath);
    const token = await this.credentials.read('github');
    const bytes = await readFile(assetPath);
    const name = input.assetName?.trim() || path.basename(assetPath);
    const url = new URL(`https://uploads.github.com/repos/${segment(input.owner, 'owner')}/${segment(input.repo, 'repository')}/releases/${releaseId}/assets`);
    url.searchParams.set('name', name);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': this.config.apiVersion,
          'User-Agent': 'Agent-Core/0.5.3',
          'Content-Type': input.contentType?.trim() || 'application/octet-stream',
          'Content-Length': String(bytes.length),
        },
        body: bytes,
      });
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      throw new GitHubFabricError('GITHUB_API_ERROR', this.credentials.redact(raw, [token]));
    }
    const text = await response.text();
    if (!response.ok) {
      throw new GitHubFabricError('GITHUB_API_ERROR', this.credentials.redact(`GitHub asset upload ${response.status}: ${text.slice(0, 1000)}`, [token]));
    }
    try { return text ? JSON.parse(text) : null; } catch { return text; }
  }
}
