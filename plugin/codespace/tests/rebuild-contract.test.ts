import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(path.join(pluginRoot, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const startup = readFileSync(path.join(pluginRoot, 'scripts', 'ensure-running.sh'), 'utf8');

describe('codespace full rebuild contract', () => {
  it('owns the runtime dependencies required by its MCP server and tests', () => {
    expect(packageJson.dependencies?.['@modelcontextprotocol/sdk']).toBe('1.30.0');
    expect(packageJson.dependencies?.zod).toBe('4.4.3');
    expect(packageJson.devDependencies?.typescript).toBe('7.0.2');
    expect(packageJson.devDependencies?.vitest).toBe('4.1.11');
    expect(packageJson.devDependencies?.['@types/node']).toBe('24.13.3');
  });

  it('restores its own dependency tree and uses local compiler/test binaries', () => {
    expect(startup).toContain('npm ci');
    expect(startup).toContain('$ROOT/node_modules/.bin/tsc');
    expect(startup).toContain('$ROOT/node_modules/.bin/vitest');
    expect(startup).not.toContain('npx tsc -p plugin/codespace/tsconfig.json');
    expect(startup).not.toContain('npx vitest run plugin/codespace/tests/mcp.integration.test.ts');
  });

  it('persists an injected lifecycle credential into ignored workspace state for later restarts', () => {
    expect(startup).toContain('mkdir -p "$(dirname "$RUNTIME_API_KEY_FILE")"');
    expect(startup).toContain('chmod 600 "$RUNTIME_API_KEY_FILE"');
    expect(startup).toContain('RUNTIME_API_KEY_REF="file:$RUNTIME_API_KEY_FILE"');
  });

  it('serializes lifecycle recovery, refreshes platform registration on start/attach, and gates remote lookup', () => {
    expect(startup).toContain('flock -w 120 9');
    expect(startup).toContain('start|attach)');
    expect(startup).toContain('runtimes stop "$ALIAS"');
    expect(startup).toContain('remote_lookup_attempted === true');
    expect(startup).toContain("payload.remote_lookup_auth_ref.startsWith('file:')");
    expect(startup).toContain('payload.remote?.id === expectedTunnelId');
  });

  it('closes the lifecycle lock descriptor before launching the long-lived tunnel runtime', () => {
    const connectBlock = startup.indexOf('connect_rc=0');
    const closeLock = startup.indexOf('exec 9>&-', connectBlock);
    const connect = startup.indexOf('runtimes connect', connectBlock);
    expect(connectBlock).toBeGreaterThanOrEqual(0);
    expect(closeLock).toBeGreaterThan(connectBlock);
    expect(closeLock).toBeLessThan(connect);
  });
});
