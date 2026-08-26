import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ANCHOR_CODESPACE_NAME,
  ANCHOR_LOCAL_BACKEND_PORT,
  ANCHOR_PUBLIC_BASE_URL,
  ANCHOR_PUBLIC_PORT,
  resolveCodespaceAnchorRole,
} from '../src/codespace/anchor-config.js';

const root = process.cwd();
const common = path.join(root, 'scripts/codespace/common.sh');

describe('Codespace anchor config', () => {
  it('pins the approved old Codespace as the Phase 1 anchor', () => {
    expect(ANCHOR_CODESPACE_NAME).toBe('ominous-xylophone-69xxp4v76vv93xq64');
    expect(ANCHOR_PUBLIC_BASE_URL).toBe('https://ominous-xylophone-69xxp4v76vv93xq64.app.github.dev');
    expect(ANCHOR_PUBLIC_PORT).toBe(8765);
    expect(ANCHOR_LOCAL_BACKEND_PORT).toBe(8766);
  });

  it('returns anchor only for the configured anchor identity', () => {
    expect(resolveCodespaceAnchorRole('ominous-xylophone-69xxp4v76vv93xq64')).toBe('anchor');
    expect(resolveCodespaceAnchorRole('future-codespace-123')).toBe('backend');
    expect(resolveCodespaceAnchorRole('')).toBe('backend');
  });

  it('exposes the same role and service-port contract to lifecycle bash', () => {
    const run = (name: string) => spawnSync('bash', ['-lc', `source "${common}"; printf '%s|%s|%s' "$(codespace_anchor_role)" "$(agent_core_service_port)" "$(anchor_public_base_url)"`], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, CODESPACE_NAME: name },
    });

    const anchor = run('ominous-xylophone-69xxp4v76vv93xq64');
    expect(anchor.status, `${anchor.stdout}\n${anchor.stderr}`).toBe(0);
    expect(anchor.stdout).toBe('anchor|8766|https://ominous-xylophone-69xxp4v76vv93xq64.app.github.dev');

    const backend = run('future-codespace-123');
    expect(backend.status, `${backend.stdout}\n${backend.stderr}`).toBe(0);
    expect(backend.stdout).toBe('backend|8765|https://ominous-xylophone-69xxp4v76vv93xq64.app.github.dev');
  });
});
