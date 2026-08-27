import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BRIDGE_NAME, BRIDGE_VERSION, sanitizeEnvironment } from '../src/constants.js';
import { CodespaceError, errorPayload } from '../src/errors.js';
import { resolveExistingPath, resolveTargetPath } from '../src/workspace.js';

describe('bridge contract', () => {
  it('uses the required identity and strips tunnel credentials', () => {
    expect(BRIDGE_NAME).toBe('codespace');
    expect(BRIDGE_VERSION).toBe('0.1.0');

    const env = sanitizeEnvironment({
      KEEP_ME: 'yes',
      CONTROL_PLANE_API_KEY: 'secret-value',
      OPENAI_ADMIN_KEY: 'admin-value',
    });

    expect(env.KEEP_ME).toBe('yes');
    expect(env.CONTROL_PLANE_API_KEY).toBeUndefined();
    expect(env.OPENAI_ADMIN_KEY).toBeUndefined();
  });

  it('returns stable structured errors without stack traces', () => {
    const payload = errorPayload(new CodespaceError('SAMPLE_ERROR', 'safe message', { sample: true }));
    expect(payload).toEqual({
      error: {
        code: 'SAMPLE_ERROR',
        message: 'safe message',
        details: { sample: true },
      },
    });
    expect(JSON.stringify(payload)).not.toContain('stack');
  });
});

describe('workspace containment', () => {
  it('accepts a file inside the workspace', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'codespace-root-'));
    try {
      const root = path.join(base, 'repo');
      await fs.mkdir(root);
      await fs.writeFile(path.join(root, 'inside.txt'), 'ok');
      await expect(resolveExistingPath(root, 'inside.txt', base)).resolves.toBe(path.join(root, 'inside.txt'));
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  it('rejects parent traversal', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'codespace-root-'));
    try {
      const root = path.join(base, 'repo');
      await fs.mkdir(root);
      await fs.writeFile(path.join(base, 'outside.txt'), 'no');
      await expect(resolveExistingPath(root, '../outside.txt', base)).rejects.toMatchObject({
        code: 'PATH_OUTSIDE_WORKSPACE',
      });
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  it('rejects a symlink escape', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'codespace-root-'));
    try {
      const root = path.join(base, 'repo');
      const outside = path.join(base, 'outside');
      await fs.mkdir(root);
      await fs.mkdir(outside);
      await fs.writeFile(path.join(outside, 'secret.txt'), 'no');
      await fs.symlink(outside, path.join(root, 'escape'));
      await expect(resolveExistingPath(root, 'escape/secret.txt', base)).rejects.toMatchObject({
        code: 'PATH_OUTSIDE_WORKSPACE',
      });
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  it('allows a new target only when its nearest existing parent is inside', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'codespace-root-'));
    try {
      const root = path.join(base, 'repo');
      await fs.mkdir(root);
      await expect(resolveTargetPath(root, 'nested/new.txt', base)).resolves.toBe(path.join(root, 'nested/new.txt'));
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });
});
