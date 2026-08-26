import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { GitHubConfig } from '../config.js';
import type { WorkspacePolicy } from '../runtime/workspace.js';
import type { GitHubApiRequest, GitHubApiResult } from './api-service.js';
import type { GitHubCredentialProvider } from './credentials.js';
import { GitHubFabricError } from './errors.js';
import { runBoundedProcess, type ProcessRunner, type SpawnResult } from './process.js';
import { assertDestructiveConfirmation } from './safety.js';

type ApiLike = { request(input: GitHubApiRequest): Promise<GitHubApiResult> };

const PACKAGE_TYPE = /^[A-Za-z0-9._-]+$/;
const GITHUB_NPM_REGISTRY = 'https://npm.pkg.github.com/';

function safePackageType(value: string): string {
  const normalized = value.trim();
  if (!normalized || !PACKAGE_TYPE.test(normalized)) {
    throw new GitHubFabricError('GITHUB_ENDPOINT_NOT_ALLOWED', 'Invalid GitHub package type');
  }
  return normalized;
}

function safePackageName(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || /[\r\n\0]/.test(normalized)) {
    throw new GitHubFabricError('GITHUB_ENDPOINT_NOT_ALLOWED', 'Invalid GitHub package name');
  }
  return encodeURIComponent(normalized);
}

function bounded(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new GitHubFabricError('GITHUB_PACKAGE_FAILED', `Package pagination value must be between 1 and ${max}`);
  }
  return value;
}

function packageFailureCode(stderr: string): 'GITHUB_PACKAGE_AUTH_FAILED' | 'GITHUB_PACKAGE_FAILED' {
  const value = stderr.toLowerCase();
  if (/\be401\b|\be403\b|unable to authenticate|authentication failed|unauthorized|forbidden/.test(value)) {
    return 'GITHUB_PACKAGE_AUTH_FAILED';
  }
  return 'GITHUB_PACKAGE_FAILED';
}

function npmInvocation(): { executable: string; prefix: string[] } {
  const envPath = process.env.npm_execpath?.trim();
  if (envPath && /npm-cli\.(?:c?js|mjs)$/i.test(envPath)) {
    return { executable: process.execPath, prefix: [envPath] };
  }
  if (process.platform === 'win32') {
    return {
      executable: process.execPath,
      prefix: [path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')],
    };
  }
  return { executable: 'npm', prefix: [] };
}

export class GitHubPackageService {
  private readonly runtimeRoot: string;

  constructor(
    private readonly config: GitHubConfig,
    private readonly credentials: GitHubCredentialProvider,
    private readonly workspace: WorkspacePolicy,
    private readonly api: ApiLike,
    private readonly runner: ProcessRunner = runBoundedProcess,
  ) {
    this.runtimeRoot = path.join(this.workspace.roots[0]!, 'runtime', 'github', 'npm');
  }

  async list(input: { packageType: string; perPage?: number; page?: number }): Promise<GitHubApiResult> {
    return this.api.request({
      method: 'GET',
      endpoint: '/user/packages',
      credential: 'packages',
      query: {
        package_type: safePackageType(input.packageType),
        per_page: bounded(input.perPage, 30, 100),
        page: bounded(input.page, 1, 10_000),
      },
    });
  }

  async getVersions(input: {
    packageType: string;
    packageName: string;
    perPage?: number;
    page?: number;
  }): Promise<GitHubApiResult> {
    const type = safePackageType(input.packageType);
    const name = safePackageName(input.packageName);
    return this.api.request({
      method: 'GET',
      endpoint: `/user/packages/${type}/${name}/versions`,
      credential: 'packages',
      query: {
        per_page: bounded(input.perPage, 30, 100),
        page: bounded(input.page, 1, 10_000),
      },
    });
  }

  async deleteVersion(input: {
    packageType: string;
    packageName: string;
    versionId: number;
    destructiveConfirmation?: string;
  }): Promise<GitHubApiResult> {
    assertDestructiveConfirmation(true, input.destructiveConfirmation);
    if (!Number.isSafeInteger(input.versionId) || input.versionId < 1) {
      throw new GitHubFabricError('GITHUB_PACKAGE_FAILED', 'Package version id must be a positive integer');
    }
    const type = safePackageType(input.packageType);
    const name = safePackageName(input.packageName);
    return this.api.request({
      method: 'DELETE',
      endpoint: `/user/packages/${type}/${name}/versions/${input.versionId}`,
      credential: 'packages',
    });
  }

  async restoreVersion(input: {
    packageType: string;
    packageName: string;
    versionId: number;
  }): Promise<GitHubApiResult> {
    if (!Number.isSafeInteger(input.versionId) || input.versionId < 1) {
      throw new GitHubFabricError('GITHUB_PACKAGE_FAILED', 'Package version id must be a positive integer');
    }
    const type = safePackageType(input.packageType);
    const name = safePackageName(input.packageName);
    return this.api.request({
      method: 'POST',
      endpoint: `/user/packages/${type}/${name}/versions/${input.versionId}/restore`,
      credential: 'packages',
    });
  }

  async npmView(input: { packageSpec: string; cwd: string }): Promise<SpawnResult> {
    const cwd = await this.workspace.resolveExisting(input.cwd);
    return this.runNpm(['view', input.packageSpec, 'version', `--registry=${GITHUB_NPM_REGISTRY}`], cwd);
  }

  async npmPublish(input: { packageDir: string; tag?: string }): Promise<SpawnResult> {
    const cwd = await this.workspace.resolveExisting(input.packageDir);
    const args = ['publish', `--registry=${GITHUB_NPM_REGISTRY}`];
    if (input.tag?.trim()) args.push('--tag', input.tag.trim());
    return this.runNpm(args, cwd);
  }

  async npmInstall(input: { cwd: string; packageSpec: string }): Promise<SpawnResult> {
    const cwd = await this.workspace.resolveExisting(input.cwd);
    return this.runNpm(['install', input.packageSpec, `--registry=${GITHUB_NPM_REGISTRY}`], cwd);
  }

  private async runNpm(args: string[], cwd: string): Promise<SpawnResult> {
    const token = await this.credentials.read('packages');
    const tempDir = path.join(this.runtimeRoot, randomUUID());
    const userConfig = path.join(tempDir, '.npmrc');
    await mkdir(tempDir, { recursive: true });
    await writeFile(
      userConfig,
      `registry=${GITHUB_NPM_REGISTRY}\n//npm.pkg.github.com/:_authToken=${token}\nalways-auth=true\n`,
      { encoding: 'utf8', mode: 0o600 },
    );

    try {
      const npm = npmInvocation();
      let result: SpawnResult;
      try {
        result = await this.runner({
          executable: npm.executable,
          args: [...npm.prefix, ...args],
          cwd,
          timeoutMs: this.config.gitTimeoutMs,
          env: {
            ...process.env,
            NPM_CONFIG_USERCONFIG: userConfig,
          },
          redact: [token],
        });
      } catch (error) {
        const raw = error instanceof Error ? error.message : String(error);
        throw new GitHubFabricError('GITHUB_PACKAGE_FAILED', this.credentials.redact(raw, [token]));
      }

      const stdout = this.credentials.redact(result.stdout, [token]);
      const stderr = this.credentials.redact(result.stderr, [token]);
      const cleaned = { ...result, stdout, stderr };
      if (result.exitCode !== 0 || result.timedOut) {
        throw new GitHubFabricError(
          packageFailureCode(stderr),
          stderr.trim() || stdout.trim() || 'GitHub Packages npm operation failed',
          {
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            outputTruncated: result.outputTruncated,
          },
        );
      }
      return cleaned;
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
