import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string) => readFile(path.join(root, relative), 'utf8');

describe('Codespace anchor lifecycle integration', () => {
  it('runs the anchor local Agent Core backend on the role-specific internal service port', async () => {
    const launcher = await read('scripts/codespace/start-agent-core.sh');
    expect(launcher).toContain('agent_core_service_host');
    expect(launcher).toContain('agent_core_service_port');
    expect(launcher).toContain('AGENT_CORE_HOST=');
    expect(launcher).toContain('AGENT_CORE_PORT=');
  });

  it('has a dedicated public anchor proxy launcher on 8765', async () => {
    const launcher = await read('scripts/codespace/start-anchor-proxy.sh');
    expect(launcher).toContain('codespace_anchor_role');
    expect(launcher).toContain('dist/codespace/anchor-server.js');
    expect(launcher).toContain('AGENT_CORE_ANCHOR_PUBLIC_PORT');
    expect(launcher).toContain('AGENT_CORE_ANCHOR_PUBLIC_BASE_URL');
  });

  it('keeps backend Codespaces on the existing single supervisor path and gives anchor workers dedicated sessions', async () => {
    const common = await read('scripts/codespace/common.sh');
    const ensure = await read('scripts/codespace/ensure-running.sh');
    expect(ensure).toContain('role="$(codespace_anchor_role)"');
    expect(ensure).toContain('service_session="$(agent_core_service_session)"');
    expect(ensure).toContain('proxy_session="$(anchor_proxy_session)"');
    expect(common).toContain('agent-core-codespace-backend');
    expect(common).toContain('agent-core-codespace-anchor');
    expect(common).toContain('agent-core-codespace-anchor-discovery');
  });

  it('checks the local service port separately from the public forwarding port', async () => {
    const common = await read('scripts/codespace/common.sh');
    expect(common).toContain('wait_for_health_port()');
    expect(common).toContain('wait_for_local_health()');
    expect(common).toContain('agent_core_service_port');
    expect(common).toContain('wait_for_anchor_proxy_health()');
    expect(common).toContain('AGENT_CORE_ANCHOR_PUBLIC_PORT');
  });

  it('initializes local fallback and runs a bounded recurring discovery watcher on anchor', async () => {
    const ensure = await read('scripts/codespace/ensure-running.sh');
    const watcher = await read('scripts/codespace/watch-anchor-backend.sh');
    expect(ensure).toContain('anchor-target.js local');
    expect(ensure).toContain('start_anchor_discovery_supervisor');
    expect(watcher).toContain('discover-anchor-backend.sh');
    expect(watcher).toContain('AGENT_CORE_ANCHOR_DISCOVERY_INTERVAL_SECONDS');
    expect(watcher).toContain('sleep "$interval"');
    expect(watcher).not.toMatch(/cat\s+.*agent-core-chatgpt-key/);
  });

  it('uses the portless anchor as the direct backend while allowing verified connection metadata to promote to the stable Worker origin', async () => {
    const ensure = await read('scripts/codespace/ensure-running.sh');
    expect(ensure).toContain('base_url="$(anchor_public_base_url)"');
    expect(ensure).toContain('connection_base_url="$base_url"');
    expect(ensure).toContain('transport="codespace-anchor-gateway"');
    expect(ensure).toContain('connection_base_url="${AGENT_CORE_STABLE_GATEWAY_BASE_URL%/}"');
    expect(ensure).toContain('transport="cloudflare-workers-stable-gateway"');
    expect(ensure).toContain('write_connection_metadata "$connection_base_url" "$transport"');
  });

  it('tracks deterministic fresh Codespace lifecycle hooks and forwards only public port 8765', async () => {
    const devcontainer = JSON.parse(await read('.devcontainer/devcontainer.json')) as Record<string, any>;
    const ensure = await read('scripts/codespace/ensure-running.sh');
    expect(devcontainer.forwardPorts).toContain(8765);
    expect(devcontainer.forwardPorts).not.toContain(8766);
    expect(devcontainer.postCreateCommand).toBe('bash scripts/codespace/bootstrap.sh --phase create');
    expect(devcontainer.postStartCommand).toBe('bash scripts/codespace/bootstrap.sh --phase start');
    expect(devcontainer.postAttachCommand).toBe('bash scripts/codespace/ensure-running.sh --repair --phase attach');
    expect(ensure).toContain('plugin/codespace/scripts/ensure-running.sh');
    expect(ensure).toContain('--phase "$phase"');
  });

  it('exposes a proxy server that resolves the active target at request time', async () => {
    const server = await read('src/codespace/anchor-server.ts');
    expect(server).toContain('startAnchorServer');
    expect(server).toContain('readAnchorTarget');
    expect(server).toContain('resolveTarget: () => readAnchorTarget');
  });
});
