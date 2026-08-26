import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const syncScript = path.join(projectRoot, 'scripts/codespace/sync-source.sh');
const tempRoots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function makeFixture(): Promise<{
  root: string;
  remote: string;
  publisher: string;
  checkout: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-core-source-sync-'));
  tempRoots.push(root);
  const remote = path.join(root, 'remote.git');
  const publisher = path.join(root, 'publisher');
  const checkout = path.join(root, 'checkout');

  execFileSync('git', ['init', '--bare', '--initial-branch=main', remote]);
  execFileSync('git', ['clone', remote, publisher]);
  git(publisher, 'config', 'user.email', 'codespace-sync@test.invalid');
  git(publisher, 'config', 'user.name', 'Codespace Sync Test');
  await writeFile(path.join(publisher, 'version.txt'), 'v1\n');
  await writeFile(path.join(publisher, 'package.json'), '{"name":"fixture","version":"9.8.7"}\n');
  git(publisher, 'add', 'version.txt', 'package.json');
  git(publisher, 'commit', '-m', 'v1');
  git(publisher, 'push', 'origin', 'main');

  execFileSync('git', ['clone', remote, checkout]);
  git(checkout, 'config', 'user.email', 'codespace-sync@test.invalid');
  git(checkout, 'config', 'user.name', 'Codespace Sync Test');
  return { root, remote, publisher, checkout };
}

async function publishNext(publisher: string, value = 'v2\n'): Promise<string> {
  await writeFile(path.join(publisher, 'version.txt'), value);
  git(publisher, 'add', 'version.txt');
  git(publisher, 'commit', '-m', value.trim());
  git(publisher, 'push', 'origin', 'main');
  return git(publisher, 'rev-parse', 'HEAD');
}

function runSync(checkout: string) {
  return spawnSync('bash', [syncScript], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENT_CORE_REPO_ROOT: checkout,
      AGENT_CORE_CODESPACE_SYNC_ENABLED: '1',
      AGENT_CORE_CODESPACE_SYNC_REMOTE: 'origin',
      AGENT_CORE_CODESPACE_SYNC_BRANCH: 'main',
    },
  });
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe('Codespace source synchronization', () => {
  it('fast-forwards a clean main checkout and preserves untracked editor state', async () => {
    const { publisher, checkout } = await makeFixture();
    const before = git(checkout, 'rev-parse', 'HEAD');
    const expected = await publishNext(publisher);
    await mkdir(path.join(checkout, '.vscode'), { recursive: true });
    await writeFile(path.join(checkout, '.vscode', 'settings.json'), '{"preserve":true}\n');

    const result = runSync(checkout);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(expected);
    expect(git(checkout, 'rev-parse', 'HEAD')).not.toBe(before);
    expect(await readFile(path.join(checkout, '.vscode', 'settings.json'), 'utf8')).toBe('{"preserve":true}\n');
    expect(result.stdout).toContain('fast-forwarded main');
  });

  it('refuses to modify a checkout with tracked local changes', async () => {
    const { publisher, checkout } = await makeFixture();
    const before = git(checkout, 'rev-parse', 'HEAD');
    await publishNext(publisher);
    await writeFile(path.join(checkout, 'version.txt'), 'local-dirty\n');

    const result = runSync(checkout);

    expect(result.status).toBe(13);
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(before);
    expect(await readFile(path.join(checkout, 'version.txt'), 'utf8')).toBe('local-dirty\n');
    expect(result.stderr).toContain('tracked local changes');
  });

  it('fails closed on a non-main checkout', async () => {
    const { publisher, checkout } = await makeFixture();
    await publishNext(publisher);
    git(checkout, 'switch', '-c', 'feature/test');
    const before = git(checkout, 'rev-parse', 'HEAD');

    const result = runSync(checkout);

    expect(result.status).toBe(14);
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(before);
    expect(result.stderr).toContain('expected branch main');
  });

  it('fails closed when local main diverges from origin/main', async () => {
    const { publisher, checkout } = await makeFixture();
    await writeFile(path.join(checkout, 'local.txt'), 'local\n');
    git(checkout, 'add', 'local.txt');
    git(checkout, 'commit', '-m', 'local commit');
    const before = git(checkout, 'rev-parse', 'HEAD');
    await publishNext(publisher);

    const result = runSync(checkout);

    expect(result.status).toBe(16);
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(before);
    expect(result.stderr).toContain('diverged');
  });

  it('fails closed when local main is ahead of origin/main', async () => {
    const { checkout } = await makeFixture();
    await writeFile(path.join(checkout, 'local.txt'), 'local\n');
    git(checkout, 'add', 'local.txt');
    git(checkout, 'commit', '-m', 'local ahead');
    const before = git(checkout, 'rev-parse', 'HEAD');

    const result = runSync(checkout);

    expect(result.status).toBe(15);
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(before);
    expect(result.stderr).toContain('ahead of origin/main');
  });

  it('is idempotent when local main already equals origin/main', async () => {
    const { checkout } = await makeFixture();
    const before = git(checkout, 'rev-parse', 'HEAD');

    const result = runSync(checkout);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(before);
    expect(result.stdout).toContain('already matches origin/main');
  });

  it('wires source synchronization before dependency/build readiness in both lifecycle entrypoints', async () => {
    const bootstrap = await readFile(path.join(projectRoot, 'scripts/codespace/bootstrap.sh'), 'utf8');
    const ensure = await readFile(path.join(projectRoot, 'scripts/codespace/ensure-running.sh'), 'utf8');

    const bootstrapSync = bootstrap.indexOf('sync-source.sh');
    const bootstrapBuild = bootstrap.indexOf("log_info 'Running full Agent Core build.'");
    const ensureSync = ensure.indexOf('sync-source.sh');
    const ensureBuildDecision = ensure.indexOf('build_required=0');

    expect(bootstrapSync).toBeGreaterThanOrEqual(0);
    expect(bootstrapSync).toBeLessThan(bootstrapBuild);
    expect(ensureSync).toBeGreaterThanOrEqual(0);
    expect(ensureSync).toBeLessThan(ensureBuildDecision);
    expect(bootstrap).toContain('Source checkout changed during synchronization; restarting bootstrap from the synchronized source.');
    expect(ensure).toContain('Source checkout changed during synchronization; restarting bootstrap from the synchronized source.');
    expect(bootstrap).toContain('AGENT_CORE_FORCE_RESTART=1');
    expect(ensure).toContain('AGENT_CORE_FORCE_RESTART');
    expect(ensure).toContain('Restarting Agent Core supervisor to activate the synchronized build.');
  });

  it('rejects a healthy process whose reported version does not match the synchronized source version', async () => {
    const common = path.join(projectRoot, 'scripts/codespace/common.sh');
    const payload = JSON.stringify({
      status: 'ok',
      service: 'agent-core',
      version: '0.5.1',
      memory: { healthy: true },
      continuity: { healthy: true },
      execution: { healthy: true },
    });
    const result = spawnSync('bash', ['-lc', `source "${common}"; printf '%s' '${payload}' | health_payload_ok '0.5.2'`], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: process.env,
    });

    expect(result.status).toBe(1);
  });

  it('records the exact source commit and package version in verified connection metadata', async () => {
    const { checkout } = await makeFixture();
    const home = path.join(path.dirname(checkout), 'runtime-home');
    const common = path.join(projectRoot, 'scripts/codespace/common.sh');
    const result = spawnSync('bash', ['-lc', `source "${common}"; write_connection_metadata "https://example.invalid" "test"`], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        AGENT_CORE_REPO_ROOT: checkout,
        AGENT_CORE_CODESPACE_HOME: home,
        AGENT_CORE_CODESPACE_PORT: '8765',
        CODESPACE_NAME: 'fixture-codespace',
      },
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const metadata = JSON.parse(await readFile(path.join(home, 'connection.json'), 'utf8')) as Record<string, unknown>;
    expect(metadata.sourceCommit).toBe(git(checkout, 'rev-parse', 'HEAD'));
    expect(metadata.sourceVersion).toBe('9.8.7');
  });
});
