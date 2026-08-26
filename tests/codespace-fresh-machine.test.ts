import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string) => readFile(path.join(root, relative), 'utf8');

const requiredTrackedFiles = [
  '.devcontainer/devcontainer.json',
  'scripts/codespace/bootstrap.sh',
  'scripts/codespace/common.sh',
  'scripts/codespace/sync-source.sh',
  'scripts/codespace/start-agent-core.sh',
  'scripts/codespace/ensure-running.sh',
  'scripts/codespace/show-connection.sh',
  'scripts/codespace/set-anchor-backend.sh',
  'scripts/codespace/discover-anchor-backend.sh',
  'scripts/codespace/start-anchor-proxy.sh',
  'scripts/codespace/watch-anchor-backend.sh',
  'scripts/codespace/update-stable-gateway.sh',
  'scripts/codespace/deploy-stable-gateway.sh',
  'scripts/codespace/stable-gateway-admin.mjs',
  'cloudflare/agent-core-gateway/worker.mjs',
  'src/codespace/anchor-config.ts',
  'src/codespace/anchor-proxy.ts',
  'src/codespace/anchor-server.ts',
  'src/codespace/anchor-target.ts',
  'src/codespace/anchor-discovery.ts',
];

const executableScripts = requiredTrackedFiles.filter((entry) => entry.endsWith('.sh'));

describe('fresh Codespace reproducibility contract', () => {
  it('tracks every required Codespace automation artifact in Git', () => {
    const tracked = new Set(execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).trim().split('\n'));
    for (const file of requiredTrackedFiles) expect(tracked.has(file), `${file} must be tracked`).toBe(true);
  });

  it('preserves executable bits for lifecycle shell entrypoints', () => {
    const staged = execFileSync('git', ['ls-files', '--stage', ...executableScripts], { cwd: root, encoding: 'utf8' });
    for (const file of executableScripts) {
      const row = staged.split('\n').find((entry) => entry.endsWith(`\t${file}`));
      expect(row, `${file} must have an index entry`).toBeTruthy();
      expect(row?.startsWith('100755 '), `${file} must be executable in a fresh checkout`).toBe(true);
    }
  });

  it('boots automatically on create, start, and attach with only public port 8765 forwarded', async () => {
    const config = JSON.parse(await read('.devcontainer/devcontainer.json')) as Record<string, any>;
    expect(config.forwardPorts).toEqual([8765]);
    expect(config.postCreateCommand).toBe('bash scripts/codespace/bootstrap.sh --phase create');
    expect(config.postStartCommand).toBe('bash scripts/codespace/bootstrap.sh --phase start');
    expect(config.postAttachCommand).toBe('bash scripts/codespace/ensure-running.sh --repair --phase attach');
  });

  it('restores known system prerequisites, Node/npm dependencies, build output, credentials, and API-key state', async () => {
    const bootstrap = await read('scripts/codespace/bootstrap.sh');
    for (const prerequisite of ['curl', 'tmux', 'git', 'gh']) expect(bootstrap).toContain(prerequisite);
    expect(bootstrap).toContain('ensure_node_runtime');
    expect(bootstrap).toContain('npm ci');
    expect(bootstrap).toContain('npm run build');
    expect(bootstrap).toContain('gh auth token');
    expect(bootstrap).toContain('agent-core-chatgpt-key.txt');
    expect(bootstrap).toContain('ensure-running.sh');
    expect(bootstrap).not.toMatch(/cat\s+.*agent-core-chatgpt-key\.txt/);
  });

  it('synchronizes clean main before build/readiness and auto-publicizes port 8765', async () => {
    const bootstrap = await read('scripts/codespace/bootstrap.sh');
    const ensure = await read('scripts/codespace/ensure-running.sh');
    expect(bootstrap.indexOf('sync-source.sh')).toBeLessThan(bootstrap.indexOf("log_info 'Running full Agent Core build.'"));
    expect(ensure.indexOf('sync-source.sh')).toBeLessThan(ensure.indexOf('build_required=0'));
    expect(ensure).toContain('gh codespace ports visibility "$AGENT_CORE_CODESPACE_PORT:public"');
    expect(ensure).toContain('Expected unauthenticated /mcp to return 401');
    expect(ensure).toContain('write_connection_metadata');
  });

  it('keeps mutable runtime state and secrets outside tracked source', async () => {
    const common = await read('scripts/codespace/common.sh');
    expect(common).toContain('/workspaces/.agent-core-codespace');
    const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
    expect(tracked).not.toMatch(/(^|\n)secrets\//);
    expect(tracked).not.toMatch(/(^|\n)runtime\//);
    expect(tracked).not.toMatch(/\.sqlite(\n|$)/);
  });
});
