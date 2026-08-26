import { createServer, type Server } from 'node:http';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { FileKeyStore } from '../src/auth/key-store.js';
import { loadConfig } from '../src/config.js';
import { GitHubCredentialProvider } from '../src/github/credentials.js';
import { GitHubGitService } from '../src/github/git-service.js';
import { GitHubPackageService } from '../src/github/package-service.js';
import type { SpawnRequest, SpawnResult } from '../src/github/process.js';
import { GitHubService } from '../src/github/service.js';
import { createHttpHandler } from '../src/http/app.js';
import { FileAuditLogger } from '../src/logging/audit-log.js';
import { createMcpHttpHandler } from '../src/mcp/handler.js';
import { createRuntimeServices, type RuntimeServices } from '../src/runtime/services.js';
import { WorkspacePolicy } from '../src/runtime/workspace.js';

const GH = 'SENTINEL_GH_TOKEN_DO_NOT_LEAK_8675309';
const PACKAGES = 'SENTINEL_PACKAGES_TOKEN_DO_NOT_LEAK_424242';
const roots: string[] = [];
const servers: Server[] = [];
const runtimes: RuntimeServices[] = [];

const ok = (stdout = ''): SpawnResult => ({
  exitCode: 0,
  stdout,
  stderr: '',
  timedOut: false,
  outputTruncated: false,
});

async function tempRoot(prefix = 'agent-core-github-leak-') {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function writeSentinelCredentials(root: string) {
  const config = loadConfig({}, root).github;
  await mkdir(path.dirname(config.tokenFile), { recursive: true });
  await writeFile(config.tokenFile, GH, 'utf8');
  await writeFile(config.packagesTokenFile, PACKAGES, 'utf8');
  return config;
}

async function call(baseUrl: string, key: string, name: string, args: Record<string, unknown> = {}) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 71, method: 'tools/call', params: { name, arguments: args } }),
  });
  return await response.json() as Record<string, any>;
}

function parsed(json: Record<string, any>) {
  return JSON.parse(json.result.content[0].text) as Record<string, any>;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(runtimes.splice(0).map(async (runtime) => {
    await runtime.execution.close().catch(() => undefined);
    await runtime.memory.close().catch(() => undefined);
  }));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Native GitHub Fabric secret boundaries', () => {
  it('redacts both credentials from MCP errors, deterministic memory, and audit logs', async () => {
    const root = await tempRoot();
    const defaults = loadConfig({}, root);
    const githubConfig = {
      ...defaults.github,
      apiBaseUrl: 'http://127.0.0.1:9',
      requestTimeoutMs: 2000,
    };
    await mkdir(path.dirname(githubConfig.tokenFile), { recursive: true });
    await writeFile(githubConfig.tokenFile, GH, 'utf8');
    await writeFile(githubConfig.packagesTokenFile, PACKAGES, 'utf8');

    let fetchCalls = 0;
    const fakeFetch: typeof fetch = async (_input, init) => {
      fetchCalls += 1;
      const auth = new Headers(init?.headers).get('authorization') ?? '';
      const echoed = auth.replace(/^Bearer\s+/i, '');
      return new Response(JSON.stringify({ message: `upstream echoed ${echoed}` }), {
        status: 500,
        headers: { 'content-type': 'application/json', 'x-github-request-id': `REQ-${fetchCalls}` },
      });
    };
    const neverRunner = async (_request: SpawnRequest) => ok();

    const logger = new FileAuditLogger(path.join(root, 'logs'));
    const runtime = createRuntimeServices(
      [root],
      path.join(root, 'capabilities'),
      logger,
      { ...defaults.memory, enabled: true, dbPath: path.join(root, 'runtime', 'memory', 'github-leak.sqlite') },
      { ...defaults.execution, enabled: false },
      githubConfig,
      { fetchImpl: fakeFetch, processRunner: neverRunner },
    );
    runtimes.push(runtime);
    const keyStore = new FileKeyStore(path.join(root, 'data'));
    const principal = await keyStore.create('github-leak-principal');
    const app = createHttpHandler({ keyStore, auditLogger: logger, mcpHandler: createMcpHttpHandler(runtime) });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const repoRoute = parsed(await call(baseUrl, principal.key, 'capability_route', {
      task: 'Get GitHub repository metadata for rendevouz999/Agent-Core',
    }));
    const repoFailure = await call(baseUrl, principal.key, 'github_repo', {
      operation: 'get', owner: 'rendevouz999', repo: 'Agent-Core', routeContextId: repoRoute.routeContextId,
    });
    const repoBody = parsed(repoFailure);
    expect(repoFailure.result.isError).toBe(true);
    expect(repoBody.error.code).toBe('GITHUB_API_ERROR');
    expect(JSON.stringify(repoFailure)).not.toContain(GH);
    expect(JSON.stringify(repoFailure)).not.toContain(PACKAGES);
    expect(JSON.stringify(repoFailure)).toContain('[REDACTED_GITHUB_CREDENTIAL]');

    const packageRoute = parsed(await call(baseUrl, principal.key, 'capability_route', {
      task: 'Get GitHub package metadata',
    }));
    const packageFailure = await call(baseUrl, principal.key, 'github_api', {
      method: 'GET', endpoint: '/user/packages', credential: 'packages', routeContextId: packageRoute.routeContextId,
    });
    expect(packageFailure.result.isError).toBe(true);
    expect(JSON.stringify(packageFailure)).not.toContain(GH);
    expect(JSON.stringify(packageFailure)).not.toContain(PACKAGES);

    const beforeMutationFetchCalls = fetchCalls;
    const mutationRoute = parsed(await call(baseUrl, principal.key, 'capability_route', {
      task: 'Update GitHub repository settings',
    }));
    const blockedMutation = await call(baseUrl, principal.key, 'github_api', {
      method: 'PATCH', endpoint: '/repos/rendevouz999/Agent-Core', body: { description: 'blocked' }, routeContextId: mutationRoute.routeContextId,
    });
    expect(parsed(blockedMutation).error.code).toBe('GITHUB_DESTRUCTIVE_CONFIRMATION_REQUIRED');
    expect(fetchCalls).toBe(beforeMutationFetchCalls);

    const scope = { principalId: principal.metadata.id, projectId: root };
    const exported = await runtime.memory.export(scope, 200);
    const memoryText = JSON.stringify(exported);
    expect(memoryText).not.toContain(GH);
    expect(memoryText).not.toContain(PACKAGES);

    const auditText = await readFile(logger.filePath, 'utf8');
    expect(auditText).not.toContain(GH);
    expect(auditText).not.toContain(PACKAGES);
  });

  it('keeps the Git credential out of args, helper source, and local git config while deleting askpass', async () => {
    const root = await tempRoot('agent-core-github-git-leak-');
    const config = await writeSentinelCredentials(root);
    const workspace = new WorkspacePolicy([root]);
    const credentials = new GitHubCredentialProvider(config);
    const repoDir = path.join(root, 'repo');
    const gitDir = path.join(repoDir, '.git');
    await mkdir(gitDir, { recursive: true });
    const gitConfig = path.join(gitDir, 'config');
    const safeConfig = '[remote "origin"]\n\turl = https://github.com/rendevouz999/Agent-Core.git\n';
    await writeFile(gitConfig, safeConfig, 'utf8');

    let captured: SpawnRequest | undefined;
    let helperSource = '';
    const runner = async (request: SpawnRequest) => {
      captured = request;
      const helper = String(request.env?.GIT_ASKPASS ?? '');
      helperSource = await readFile(helper, 'utf8');
      return ok('safe-output\n');
    };
    const git = new GitHubGitService(config, credentials, workspace, runner);
    await git.fetch({ cwd: repoDir, remote: 'origin' });

    expect(JSON.stringify(captured?.args)).not.toContain(GH);
    expect(JSON.stringify(captured?.args)).not.toContain(PACKAGES);
    expect(helperSource).not.toContain(GH);
    expect(helperSource).not.toContain(PACKAGES);
    expect(captured?.env?.AGENT_CORE_GITHUB_ASKPASS_TOKEN).toBe(GH);
    expect(await readFile(gitConfig, 'utf8')).toBe(safeConfig);
    await expect(access(String(captured?.env?.GIT_ASKPASS))).rejects.toThrow();
  });

  it('keeps package credentials out of npm args/output and deletes the transient npm config', async () => {
    const root = await tempRoot('agent-core-github-npm-leak-');
    const config = await writeSentinelCredentials(root);
    const workspace = new WorkspacePolicy([root]);
    const credentials = new GitHubCredentialProvider(config);
    const api = { request: async () => ({ ok: true, status: 200, method: 'GET', endpoint: '/user/packages', headers: {}, data: [] }) };
    let captured: SpawnRequest | undefined;
    let transientContents = '';
    let transientPath = '';
    const runner = async (request: SpawnRequest) => {
      captured = request;
      transientPath = String(request.env?.NPM_CONFIG_USERCONFIG ?? '');
      transientContents = await readFile(transientPath, 'utf8');
      return ok('package-ok\n');
    };
    const packages = new GitHubPackageService(config, credentials, workspace, api, runner);
    const result = await packages.npmView({ packageSpec: '@rendevouz999/agent-core-plugin', cwd: root });

    expect(transientContents).toContain(PACKAGES);
    expect(JSON.stringify(captured?.args)).not.toContain(PACKAGES);
    expect(JSON.stringify(captured?.args)).not.toContain(GH);
    expect(result.stdout).not.toContain(PACKAGES);
    await expect(access(transientPath)).rejects.toThrow();
    const npmRoot = path.join(root, 'runtime', 'github', 'npm');
    const remaining = await readdir(npmRoot).catch(() => [] as string[]);
    expect(remaining).toEqual([]);
  });

  it('prevents force push before the credential or process runner is used', async () => {
    const root = await tempRoot('agent-core-github-force-leak-');
    const config = await writeSentinelCredentials(root);
    const workspace = new WorkspacePolicy([root]);
    const credentials = new GitHubCredentialProvider(config);
    const repoDir = path.join(root, 'repo');
    await mkdir(repoDir);
    let calls = 0;
    const git = new GitHubGitService(config, credentials, workspace, async () => { calls += 1; return ok(); });
    await expect(git.push({ cwd: repoDir, remote: 'origin', refspec: 'main', force: true }))
      .rejects.toMatchObject({ code: 'GITHUB_DESTRUCTIVE_CONFIRMATION_REQUIRED' });
    expect(calls).toBe(0);
  });

  it('keeps tracked plugin and stable release sources free of credential values and secret-file literals', async () => {
    const files = [
      'plugin/agent-core/README.md',
      'plugin/agent-core/skills/agent-core-github/SKILL.md',
      'scripts/release/build-release.ps1',
    ];
    const contents = (await Promise.all(files.map((file) => readFile(path.resolve(file), 'utf8')))).join('\n');
    expect(contents).not.toContain(GH);
    expect(contents).not.toContain(PACKAGES);
    expect(contents).not.toContain('gh-token.txt');
    expect(contents).not.toContain('packages-token.txt');
    expect(contents).toContain('agent-core-github');
  });

  it('supports injected transports so deterministic security tests never require external GitHub access', async () => {
    const root = await tempRoot('agent-core-github-injected-');
    const config = await writeSentinelCredentials(root);
    config.apiBaseUrl = 'http://127.0.0.1:9';
    const workspace = new WorkspacePolicy([root]);
    let fakeFetchCalls = 0;
    const fakeFetch: typeof fetch = async () => {
      fakeFetchCalls += 1;
      return new Response(JSON.stringify({ login: 'fake-user' }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const github = new GitHubService(config, workspace, { fetchImpl: fakeFetch, processRunner: async () => ok() });
    const result = await github.apiRequest({ method: 'GET', endpoint: '/user' });
    expect(fakeFetchCalls).toBe(1);
    expect(result.data).toEqual({ login: 'fake-user' });
  });
});
