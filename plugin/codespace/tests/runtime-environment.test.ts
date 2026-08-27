import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let base: string;
let packageRoot: string;

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'codespace-runtime-env-'));
  packageRoot = path.join(base, 'codespace');
  await fs.mkdir(path.join(packageRoot, 'runtime'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

describe('managed runtime environment fallback', () => {
  it('makes tmux unavailable only for the managed launch and restores the original PATH', () => {
    const helper = path.join(pluginRoot, 'scripts', 'runtime-environment.sh');
    const originalPath = '/usr/local/bin:/usr/bin:/bin';
    const script = [
      'set -u',
      'source "$1"',
      'codespace_prepare_process_runtime "$2"',
      'printf \'ORIGINAL=%s\\n\' "$CODESPACE_ORIGINAL_PATH"',
      'printf \'TMUX=%s\\n\' "$(command -v tmux)"',
      'set +e',
      'tmux -V >/dev/null 2>&1',
      'rc=$?',
      'set -e',
      'printf \'TMUX_RC=%s\\n\' "$rc"',
      'codespace_restore_original_path',
      'printf \'RESTORED=%s\\n\' "$PATH"',
      'printf \'MARKER=%s\\n\' "${CODESPACE_ORIGINAL_PATH-unset}"',
    ].join('\n');

    const result = spawnSync('/bin/bash', ['-c', script, 'bash', helper, packageRoot], {
      env: { ...process.env, PATH: originalPath },
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`ORIGINAL=${originalPath}`);
    expect(result.stdout).toContain(`TMUX=${path.join(packageRoot, 'runtime', 'no-tmux-bin', 'tmux')}`);
    expect(result.stdout).toContain('TMUX_RC=127');
    expect(result.stdout).toContain(`RESTORED=${originalPath}`);
    expect(result.stdout).toContain('MARKER=unset');
  });
});
