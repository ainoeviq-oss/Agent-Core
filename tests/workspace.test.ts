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
    const root = await tempRoot('agent-core-root-');
    await mkdir(path.join(root, 'nested'));
    const policy = new WorkspacePolicy([root]);

    await expect(policy.resolveExisting(path.join(root, 'nested'))).resolves.toBe(path.join(root, 'nested'));
    await expect(policy.resolveTarget(path.join(root, '..', 'escape.txt'))).rejects.toThrow(/outside allowed roots/i);
  });

  it('rejects an existing symlink or junction escape', async () => {
    const root = await tempRoot('agent-core-root-');
    const outside = await tempRoot('agent-core-outside-');
    await writeFile(path.join(outside, 'secret.txt'), 'outside');
    const link = path.join(root, 'escape-link');
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    const policy = new WorkspacePolicy([root]);

    await expect(policy.resolveExisting(path.join(link, 'secret.txt'))).rejects.toThrow(/outside allowed roots/i);
  });

  it('allows a new target only when its nearest existing parent is allowed', async () => {
    const root = await tempRoot('agent-core-root-');
    await mkdir(path.join(root, 'nested'));
    const policy = new WorkspacePolicy([root]);

    await expect(policy.resolveTarget(path.join(root, 'nested', 'new', 'file.txt')))
      .resolves.toBe(path.join(root, 'nested', 'new', 'file.txt'));
  });

  it('resolves a single configured project without guessing from array position', async () => {
    const root = await tempRoot('agent-core-project-single-');
    const policy = new WorkspacePolicy([root]);
    expect(policy.resolveProjectRoot()).toBe(root);
  });

  it('resolves the exact project from an explicit project root or bounded task/context path evidence', async () => {
    const container = await tempRoot('agent-core-project-multi-');
    const projectA = path.join(container, 'project-a');
    const projectB = path.join(container, 'project-b');
    await Promise.all([mkdir(projectA), mkdir(projectB)]);
    const policy = new WorkspacePolicy([projectA, projectB]);

    expect(policy.resolveProjectRoot({ explicitRoot: projectB })).toBe(projectB);
    expect(policy.resolveProjectRoot({ texts: [`Please work only in ${projectB} for this task.`] })).toBe(projectB);
    expect(policy.resolveProjectRoot({ candidatePaths: [path.join(projectA, 'src', 'index.ts')] })).toBe(projectA);
  });

  it('fails closed when multiple project roots are configured but no unique project evidence exists', async () => {
    const container = await tempRoot('agent-core-project-ambiguous-');
    const projectA = path.join(container, 'project-a');
    const projectB = path.join(container, 'project-b');
    await Promise.all([mkdir(projectA), mkdir(projectB)]);
    const policy = new WorkspacePolicy([projectA, projectB]);

    expect(() => policy.resolveProjectRoot()).toThrow(/WORKSPACE_PROJECT_AMBIGUOUS/);
    expect(() => policy.resolveProjectRoot({ texts: ['work on the project'] })).toThrow(/WORKSPACE_PROJECT_AMBIGUOUS/);
    expect(() => policy.resolveProjectRoot({ candidatePaths: [projectA, projectB] })).toThrow(/WORKSPACE_PROJECT_AMBIGUOUS/);
  });

  it('enforces the routed project boundary even when another allowed root is globally accessible', async () => {
    const container = await tempRoot('agent-core-project-boundary-');
    const projectA = path.join(container, 'project-a');
    const projectB = path.join(container, 'project-b');
    await Promise.all([mkdir(projectA), mkdir(projectB)]);
    await writeFile(path.join(projectA, 'a.txt'), 'A');
    await writeFile(path.join(projectB, 'b.txt'), 'B');
    const policy = new WorkspacePolicy([projectA, projectB]);

    await expect(policy.resolveExistingInProject(projectA, path.join(projectA, 'a.txt')))
      .resolves.toBe(path.join(projectA, 'a.txt'));
    await expect(policy.resolveExistingInProject(projectA, path.join(projectB, 'b.txt')))
      .rejects.toThrow(/outside routed project/i);
    await expect(policy.resolveTargetInProject(projectB, path.join(projectA, 'new.txt')))
      .rejects.toThrow(/outside routed project/i);
  });
});
