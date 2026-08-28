import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = path.join(pluginRoot, 'scripts', 'install-account-codespaces-secret.sh');

describe('account-level Codespaces secret bootstrap', () => {
  it('ships a permanent installer that scopes the user secret to the current repository without printing its value', () => {
    expect(existsSync(scriptPath)).toBe(true);
    if (!existsSync(scriptPath)) return;

    const script = readFileSync(scriptPath, 'utf8');
    expect(script).toContain('gh secret set');
    expect(script).toContain('--user');
    expect(script).toContain('--app codespaces');
    expect(script).toContain('--repos');
    expect(script).toContain('< "$KEY_FILE"');
    expect(script).not.toContain('cat "$KEY_FILE"');
    expect(script).not.toContain('echo "$CONTROL_PLANE_API_KEY"');
  });

  it('keeps fresh Codespace startup wired to the account-injected environment credential', () => {
    const startup = readFileSync(path.join(pluginRoot, 'scripts', 'ensure-running.sh'), 'utf8');
    expect(startup).toContain('${CONTROL_PLANE_API_KEY:-}');
    expect(startup).toContain('RUNTIME_API_KEY_FILE');
    expect(startup).toContain('chmod 600');
  });
});
