import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

async function readJson(relative: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path.join(root, relative), 'utf8')) as Record<string, any>;
}

async function read(relative: string): Promise<string> {
  return readFile(path.join(root, relative), 'utf8');
}

describe('Codespaces deployment contract', () => {
  it('forwards Agent Core MCP port and uses one deterministic lifecycle chain that also starts the codespace plugin', async () => {
    const config = await readJson('.devcontainer/devcontainer.json');
    const ensure = await read('scripts/codespace/ensure-running.sh');
    expect(config.forwardPorts).toContain(8765);
    expect(config.postCreateCommand).toBe('bash scripts/codespace/bootstrap.sh --phase create');
    expect(config.postStartCommand).toBe('bash scripts/codespace/bootstrap.sh --phase start');
    expect(config.postAttachCommand).toBe('bash scripts/codespace/ensure-running.sh --repair --phase attach');
    expect(ensure).toContain('plugin/codespace/scripts/ensure-running.sh');
    expect(ensure).toContain('--phase "$phase"');
    expect(config.portsAttributes['8765']?.label).toBe('Agent Core MCP');
  });

  it('keeps Codespace runtime state outside tracked source and never embeds secrets', async () => {
    const common = await read('scripts/codespace/common.sh');
    expect(common).toContain('/workspaces/.agent-core-codespace');
    expect(common).toContain('AGENT_CORE_CODESPACE_PORT="${AGENT_CORE_CODESPACE_PORT:-8765}"');
    expect(common).not.toMatch(/agent_core_live_[A-Za-z0-9_-]+/);
  });

  it('pins the Phase 1 anchor identity without changing the non-anchor service port', async () => {
    const common = await read('scripts/codespace/common.sh');
    expect(common).toContain('AGENT_CORE_ANCHOR_CODESPACE_NAME="${AGENT_CORE_ANCHOR_CODESPACE_NAME:-ominous-xylophone-69xxp4v76vv93xq64}"');
    expect(common).toContain('AGENT_CORE_ANCHOR_PUBLIC_BASE_URL="${AGENT_CORE_ANCHOR_PUBLIC_BASE_URL:-https://ominous-xylophone-69xxp4v76vv93xq64.app.github.dev}"');
    expect(common).toContain('AGENT_CORE_ANCHOR_LOCAL_BACKEND_PORT="${AGENT_CORE_ANCHOR_LOCAL_BACKEND_PORT:-8766}"');
    expect(common).toContain('codespace_anchor_role()');
    expect(common).toContain('agent_core_service_port()');
  });

  it('starts Agent Core with isolated Codespace runtime paths and role-aware binding', async () => {
    const launcher = await read('scripts/codespace/start-agent-core.sh');
    expect(launcher).toContain('service_port="$(agent_core_service_port)"');
    expect(launcher).toContain('service_host="$(agent_core_service_host)"');
    expect(launcher).toContain('AGENT_CORE_HOST="$service_host"');
    expect(launcher).toContain('AGENT_CORE_PORT="$service_port"');
    expect(launcher).toContain('AGENT_CORE_ALLOWED_ROOTS="$AGENT_CORE_REPO_ROOT"');
    expect(launcher).toContain('exec "$NODE_BIN" dist/index.js');
    expect(launcher).not.toContain('agent_core_live_');
  });

  it('installs only known prerequisites and uses the lockfile for npm recovery', async () => {
    const bootstrap = await read('scripts/codespace/bootstrap.sh');
    expect(bootstrap).toContain('tmux');
    expect(bootstrap).toContain('curl');
    expect(bootstrap).toContain('npm ci');
    expect(bootstrap).toContain('npm run build');
    expect(bootstrap).toContain('secrets/github/gh-token.txt');
    expect(bootstrap).not.toContain('eval "$');
  });

  it('isolates prerequisite APT installs from unrelated third-party repositories', async () => {
    const bootstrap = await read('scripts/codespace/bootstrap.sh');
    expect(bootstrap).toContain('apt_primary_source="/etc/apt/sources.list"');
    expect(bootstrap).toContain('Dir::Etc::sourcelist=$apt_primary_source');
    expect(bootstrap).toContain('Dir::Etc::sourceparts=-');
    expect(bootstrap).toContain('APT::Get::List-Cleanup=0');
    expect(bootstrap).not.toContain('allow-unauthenticated');
    expect(bootstrap).not.toContain('Acquire::AllowInsecureRepositories');
    expect(bootstrap).not.toContain('trusted=yes');
  });

  it('does not report READY before local/public/OAuth/MCP gates are verified', async () => {
    const ensure = await read('scripts/codespace/ensure-running.sh');
    const readyIndex = ensure.indexOf("log_info 'READY:");
    expect(ensure).toContain('wait_for_local_health');
    expect(ensure).toContain('codespace_browse_url');
    expect(ensure).toContain('gh codespace ports visibility');
    expect(ensure).toContain('/.well-known/oauth-authorization-server');
    expect(ensure).toContain('Expected unauthenticated /mcp to return 401');
    const common = await read('scripts/codespace/common.sh');
    expect(ensure).toContain('write_connection_metadata');
    expect(common).toContain('mcp-url.txt');
    expect(readyIndex).toBeGreaterThan(ensure.indexOf('write_connection_metadata'));
  });

  it('exposes safe connection commands without reading the API key file', async () => {
    const show = await read('scripts/codespace/show-connection.sh');
    const pkg = await readJson('package.json');
    expect(show).toContain('connection.json');
    expect(show).toContain('mcp-url.txt');
    expect(show).not.toContain('agent-core-chatgpt-key.txt');
    expect(pkg.scripts['codespace:bootstrap']).toBe('bash scripts/codespace/bootstrap.sh --phase manual');
    expect(pkg.scripts['codespace:repair']).toBe('bash scripts/codespace/ensure-running.sh --repair --phase manual');
    expect(pkg.scripts['codespace:connection']).toBe('bash scripts/codespace/show-connection.sh');
    expect(pkg.scripts['codespace:gateway:update']).toBe('bash scripts/codespace/update-stable-gateway.sh');
    expect(pkg.scripts['codespace:gateway:deploy']).toBe('bash scripts/codespace/deploy-stable-gateway.sh');
  });

  it('never prints the Codespace API key during automatic lifecycle scripts', async () => {
    const files = await Promise.all([
      'scripts/codespace/bootstrap.sh',
      'scripts/codespace/ensure-running.sh',
      'scripts/codespace/show-connection.sh',
      'scripts/codespace/start-agent-core.sh',
    ].map(read));
    for (const text of files) {
      expect(text).not.toMatch(/cat\s+.*agent-core-chatgpt-key\.txt/);
      expect(text).not.toMatch(/agent_core_live_[A-Za-z0-9_-]{12,}/);
    }
  });

  it('fails closed with bounded lifecycle exit categories', async () => {
    const bootstrap = await read('scripts/codespace/bootstrap.sh');
    const ensure = await read('scripts/codespace/ensure-running.sh');
    for (const code of ['10', '20', '30', '40', '50']) expect(bootstrap).toContain(`exit ${code}`);
    for (const code of ['60', '70', '80', '81', '90', '91', '92']) expect(ensure).toContain(`exit ${code}`);
  });
});
