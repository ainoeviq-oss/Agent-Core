import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readOptional = (relativePath: string) => {
  const filePath = path.join(pluginRoot, relativePath);
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
};

const startup = readOptional('scripts/ensure-running.sh');
const ensureHttp = readOptional('scripts/ensure-http-mcp.sh');
const startHttp = readOptional('scripts/start-http-mcp.sh');

describe('codespace managed Streamable HTTP lifecycle contract', () => {
  it('owns loopback HTTP MCP supervisor scripts that never expose credentials or inherit lifecycle locks', () => {
    expect(ensureHttp).not.toBe('');
    expect(startHttp).not.toBe('');
    expect(ensureHttp).toContain('codespace-mcp-http');
    expect(ensureHttp).toContain('127.0.0.1');
    expect(ensureHttp).toContain('dist/http-probe.js');
    expect(startHttp).toContain('exec 9>&-');
    expect(startHttp).toContain('unset CONTROL_PLANE_API_KEY');
    expect(startHttp).toContain('exec node "$ROOT/dist/http-server.js"');
  });

  it('restarts a protocol-healthy server when compiled output is newer than its URL state', () => {
    expect(ensureHttp).toContain('build_is_current');
    expect(ensureHttp).toContain('find "$ROOT/dist" -type f -newer "$URL_FILE"');
    expect(ensureHttp).toContain('health_ok && url_file_matches && build_is_current && protocol_ok');
  });

  it('probes the local MCP protocol before reconnecting the managed tunnel', () => {
    const ensureIndex = startup.indexOf('ensure-http-mcp.sh');
    const stopIndex = startup.indexOf('runtimes stop "$ALIAS"');
    const connectIndex = startup.indexOf('runtimes connect');
    expect(ensureIndex).toBeGreaterThanOrEqual(0);
    expect(stopIndex).toBeGreaterThan(ensureIndex);
    expect(connectIndex).toBeGreaterThan(stopIndex);
    expect(startup).toContain('MCP_SERVER_URL');
    expect(startup).toContain('dist/http-probe.js');
  });

  it('connects tunnel-client to a loopback HTTP MCP URL instead of readiness-blind stdio', () => {
    expect(startup).toContain('--mcp-server-url "$MCP_SERVER_URL"');
    expect(startup).not.toContain('--mcp-command "bash $ROOT/scripts/start-mcp.sh"');
    expect(startup).toContain("payload.process?.target_kind === 'url'");
    expect(startup).toContain('payload.process?.target_value === expectedMcpServerUrl');
  });

  it('treats all compiled HTTP lifecycle entrypoints as rebuild requirements', () => {
    expect(startup).toContain('$ROOT/dist/http-server.js');
    expect(startup).toContain('$ROOT/dist/http-probe.js');
  });
});
