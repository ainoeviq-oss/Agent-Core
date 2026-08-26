import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyExecutionArtifacts } from '../src/execution/evidence.js';
import type { ValidatedExecutionArtifact } from '../src/execution/dag.js';
import { WorkspacePolicy } from '../src/runtime/workspace.js';

const roots: string[] = [];

async function fixture(label: string) {
  const root = await mkdtemp(path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), `agent-core-execution-evidence-${label}-`));
  roots.push(root);
  const work = path.join(root, 'work');
  await mkdir(work, { recursive: true });
  return { root, work, workspace: new WorkspacePolicy([root]) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function artifact(pathValue: string, overrides: Partial<ValidatedExecutionArtifact> = {}): ValidatedExecutionArtifact {
  return {
    path: pathValue,
    kind: 'file',
    required: true,
    ...overrides,
  };
}

describe('execution artifact evidence verifier', () => {
  it('returns verified SHA256/size/type facts for required declared files', async () => {
    const f = await fixture('verified');
    const target = path.join(f.work, 'result.json');
    const bytes = Buffer.from('{"ok":true}\n', 'utf8');
    await writeFile(target, bytes);

    const result = await verifyExecutionArtifacts(f.workspace, [artifact(target, { hash: 'sha256' })]);
    expect(result.verification).toBe('verified');
    expect(result.artifacts).toEqual([expect.objectContaining({
      path: target,
      kind: 'file',
      required: true,
      exists: true,
      verification: 'verified',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })]);
  });

  it('fails required missing artifacts but does not fail for an optional missing artifact', async () => {
    const f = await fixture('missing');
    const required = await verifyExecutionArtifacts(f.workspace, [artifact(path.join(f.work, 'missing.txt'))]);
    expect(required.verification).toBe('failed');
    expect(required.artifacts[0]).toMatchObject({ exists: false, verification: 'missing', required: true });

    const optional = await verifyExecutionArtifacts(f.workspace, [artifact(path.join(f.work, 'optional.txt'), { required: false })]);
    expect(optional.verification).toBe('verified');
    expect(optional.artifacts[0]).toMatchObject({ exists: false, verification: 'missing', required: false });
  });

  it('fails factual file/directory type mismatches', async () => {
    const f = await fixture('type');
    const directory = path.join(f.work, 'dir');
    await mkdir(directory);
    const result = await verifyExecutionArtifacts(f.workspace, [artifact(directory)]);
    expect(result.verification).toBe('failed');
    expect(result.artifacts[0]).toMatchObject({ exists: true, verification: 'type_mismatch', actualKind: 'directory' });
  });

  it('rejects an artifact path that resolves through a symlink outside the allowed workspace', async () => {
    const f = await fixture('escape');
    const outside = await mkdtemp(path.join(os.tmpdir(), 'agent-core-execution-evidence-outside-'));
    roots.push(outside);
    await writeFile(path.join(outside, 'secret.txt'), 'outside');
    const link = path.join(f.work, 'escape-link');
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(verifyExecutionArtifacts(f.workspace, [artifact(path.join(link, 'secret.txt'))]))
      .rejects.toThrow(/outside|workspace/i);
  });

  it('returns not_declared without touching filesystem when no artifacts were declared', async () => {
    const f = await fixture('none');
    const result = await verifyExecutionArtifacts(f.workspace, []);
    expect(result).toEqual({ verification: 'not_declared', artifacts: [] });
    expect(await readFile(path.join(f.work, 'does-not-exist'), 'utf8').catch(() => null)).toBeNull();
  });
});
