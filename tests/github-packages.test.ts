import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { GitHubApiRequest, GitHubApiResult } from '../src/github/api-service.js';
import { GitHubCredentialProvider } from '../src/github/credentials.js';
import { GitHubPackageService } from '../src/github/package-service.js';
import type { SpawnRequest, SpawnResult } from '../src/github/process.js';
import { GITHUB_DESTRUCTIVE_CONFIRMATION } from '../src/github/safety.js';
import { WorkspacePolicy } from '../src/runtime/workspace.js';

const roots: string[] = [];
const PACKAGE_TOKEN = 'SENTINEL_PACKAGES_TOKEN_424242';

const ok = (stdout = ''): SpawnResult => ({
  exitCode: 0,
  stdout,
  stderr: '',
  timedOut: false,
  outputTruncated: false,
});

async function setup(options: {
  apiRequest?: (input: GitHubApiRequest) => Promise<GitHubApiResult>;
  runner?: (request: SpawnRequest) => Promise<SpawnResult>;
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-core-github-packages-'));
  roots.push(root);
  const config = loadConfig({}, root).github;
  await mkdir(path.dirname(config.packagesTokenFile), { recursive: true });
  await writeFile(config.packagesTokenFile, PACKAGE_TOKEN, 'utf8');
  await writeFile(config.tokenFile, 'GENERAL_TOKEN', 'utf8');
  const credentials = new GitHubCredentialProvider(config);
  const workspace = new WorkspacePolicy([root]);
  const seenApi: GitHubApiRequest[] = [];
  const api = {
    request: async (input: GitHubApiRequest) => {
      seenApi.push(input);
      if (options.apiRequest) return options.apiRequest(input);
      return { ok: true, status: 200, method: input.method, endpoint: input.endpoint, headers: {}, data: [] };
    },
  };
  const runner = options.runner ?? (async () => ok());
  const service = new GitHubPackageService(config, credentials, workspace, api, runner);
  return { root, config, credentials, workspace, service, seenApi };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('GitHubPackageService', () => {
  it('uses the packages credential for authenticated user package listing', async () => {
    const { service, seenApi } = await setup();
    await service.list({ packageType: 'npm', perPage: 25, page: 2 });
    expect(seenApi).toEqual([expect.objectContaining({
      method: 'GET',
      endpoint: '/user/packages',
      credential: 'packages',
      query: { package_type: 'npm', per_page: 25, page: 2 },
    })]);
  });

  it('encodes package names when listing versions', async () => {
    const { service, seenApi } = await setup();
    await service.getVersions({ packageType: 'npm', packageName: '@scope/pkg', perPage: 30, page: 1 });
    expect(seenApi[0]).toMatchObject({
      method: 'GET',
      endpoint: '/user/packages/npm/%40scope%2Fpkg/versions',
      credential: 'packages',
      query: { per_page: 30, page: 1 },
    });
  });

  it('requires destructive confirmation before deleting a package version', async () => {
    const { service, seenApi } = await setup();
    await expect(service.deleteVersion({ packageType: 'npm', packageName: 'demo', versionId: 123 }))
      .rejects.toMatchObject({ code: 'GITHUB_DESTRUCTIVE_CONFIRMATION_REQUIRED' });
    expect(seenApi).toHaveLength(0);

    await service.deleteVersion({
      packageType: 'npm',
      packageName: 'demo',
      versionId: 123,
      destructiveConfirmation: GITHUB_DESTRUCTIVE_CONFIRMATION,
    });
    expect(seenApi[0]).toMatchObject({
      method: 'DELETE',
      endpoint: '/user/packages/npm/demo/versions/123',
      credential: 'packages',
    });
  });

  it('restores a package version through the packages credential', async () => {
    const { service, seenApi } = await setup();
    await service.restoreVersion({ packageType: 'npm', packageName: 'demo', versionId: 9 });
    expect(seenApi[0]).toMatchObject({
      method: 'POST',
      endpoint: '/user/packages/npm/demo/versions/9/restore',
      credential: 'packages',
    });
  });

  it('uses a transient npm config with token absent from process args and deletes it after npm view', async () => {
    let captured: SpawnRequest | undefined;
    let configContents = '';
    const { root, service } = await setup({
      runner: async (request) => {
        captured = request;
        const userConfig = request.env?.NPM_CONFIG_USERCONFIG;
        expect(userConfig).toBeTruthy();
        configContents = await readFile(String(userConfig), 'utf8');
        return ok('0.5.0\n');
      },
    });
    const result = await service.npmView({ packageSpec: '@rendevouz999/agent-core-plugin', cwd: root });
    expect(result.stdout).toContain('0.5.0');
    expect(configContents).toContain(`:_authToken=${PACKAGE_TOKEN}`);
    expect(JSON.stringify(captured?.args)).not.toContain(PACKAGE_TOKEN);
    expect(captured?.env?.NPM_CONFIG_USERCONFIG).toContain(path.join('runtime', 'github', 'npm'));
    await expect(access(String(captured?.env?.NPM_CONFIG_USERCONFIG))).rejects.toThrow();
  });

  it('deletes transient npm config on runner failure and redacts the token', async () => {
    let configPath = '';
    const { root, service } = await setup({
      runner: async (request) => {
        configPath = String(request.env?.NPM_CONFIG_USERCONFIG ?? '');
        await access(configPath);
        throw new Error(`npm runner exploded ${PACKAGE_TOKEN}`);
      },
    });
    const caught = await service.npmView({ packageSpec: '@rendevouz999/pkg', cwd: root }).catch((error) => error as Error & { code?: string });
    expect(caught.code).toBe('GITHUB_PACKAGE_FAILED');
    expect(caught.message).not.toContain(PACKAGE_TOKEN);
    expect(configPath).toBeTruthy();
    await expect(access(configPath)).rejects.toThrow();
  });

  it('classifies npm auth failures separately', async () => {
    const { root, service } = await setup({
      runner: async () => ({ ...ok(), exitCode: 1, stderr: 'npm error code E401 Unable to authenticate' }),
    });
    await expect(service.npmView({ packageSpec: '@rendevouz999/pkg', cwd: root }))
      .rejects.toMatchObject({ code: 'GITHUB_PACKAGE_AUTH_FAILED' });
  });

  it('rejects npm publish directories outside the workspace before runner invocation', async () => {
    let calls = 0;
    const { service } = await setup({ runner: async () => { calls += 1; return ok(); } });
    const outside = path.resolve(os.tmpdir(), `outside-npm-publish-${Date.now()}`);
    await mkdir(outside, { recursive: true });
    try {
      await expect(service.npmPublish({ packageDir: outside })).rejects.toThrow('outside allowed roots');
      expect(calls).toBe(0);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('runs npm install in a workspace-contained cwd without writing global npm config', async () => {
    let captured: SpawnRequest | undefined;
    const { root, service } = await setup({ runner: async (request) => { captured = request; return ok(); } });
    await service.npmInstall({ cwd: root, packageSpec: '@rendevouz999/pkg@1.0.0' });
    expect(captured?.args.join(' ')).toContain('install');
    expect(captured?.args).toContain('@rendevouz999/pkg@1.0.0');
    expect(captured?.env?.NPM_CONFIG_USERCONFIG).toBeTruthy();
    expect(JSON.stringify(captured?.args)).not.toContain(PACKAGE_TOKEN);
  });
});
