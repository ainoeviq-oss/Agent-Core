import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspacePolicy } from '../src/runtime/workspace.js';

const roots: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('WorkspacePolicy', () => {
  it('allows paths inside configured roots and rejects traversal outside', async () => {
    const root = await tempRoot('commander-root-');
    await mkdir(path.join(root, 'nested'));
    const policy = new WorkspacePolicy([root]);

    await expect(policy.resolveExisting(path.join(root, 'nested'))).resolves.toBe(path.join(root, 'nested'));
    await expect(policy.resolveTarget(path.join(root, '..', 'escape.txt'))).rejects.toThrow(/outside allowed roots/i);
  });

  it('rejects an existing symlink or junction escape', async () => {
    const root = await tempRoot('commander-root-');
    const outside = await tempRoot('commander-outside-');
    await writeFile(path.join(outside, 'secret.txt'), 'outside');
    const link = path.join(root, 'escape-link');
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    const policy = new WorkspacePolicy([root]);

    await expect(policy.resolveExisting(path.join(link, 'secret.txt'))).rejects.toThrow(/outside allowed roots/i);
  });

  it('allows a new target only when its nearest existing parent is allowed', async () => {
    const root = await tempRoot('commander-root-');
    await mkdir(path.join(root, 'nested'));
    const policy = new WorkspacePolicy([root]);

    await expect(policy.resolveTarget(path.join(root, 'nested', 'new', 'file.txt')))
      .resolves.toBe(path.join(root, 'nested', 'new', 'file.txt'));
  });
});
