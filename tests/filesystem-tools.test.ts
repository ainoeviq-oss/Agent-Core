import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileSystemService } from '../src/runtime/filesystem.js';
import { WorkspacePolicy } from '../src/runtime/workspace.js';

const roots: string[] = [];
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-core-fs-'));
  roots.push(root);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'agent-core-fs-out-'));
  roots.push(outside);
  return { root, outside, fs: new FileSystemService(new WorkspacePolicy([root])) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('FileSystemService', () => {
  it('lists directories and reads single or multiple text files', async () => {
    const { root, fs } = await setup();
    await mkdir(path.join(root, 'nested'));
    await writeFile(path.join(root, 'a.txt'), 'alpha\nbeta\ngamma\n');
    await writeFile(path.join(root, 'nested', 'b.txt'), 'bravo');

    const listed = await fs.listDirectory(root, 2);
    expect(listed.entries.map((entry) => entry.path)).toEqual(expect.arrayContaining([
      path.join(root, 'a.txt'), path.join(root, 'nested'), path.join(root, 'nested', 'b.txt'),
    ]));

    const single = await fs.readFile(path.join(root, 'a.txt'), { startLine: 1, lineCount: 1 });
    expect(single.content).toBe('beta');
    const many = await fs.readMultipleFiles([path.join(root, 'a.txt'), path.join(root, 'nested', 'b.txt')]);
    expect(many.files.map((file) => file.content)).toEqual(['alpha\nbeta\ngamma\n', 'bravo']);
  });

  it('writes, appends, edits, creates directories, moves files, and returns metadata', async () => {
    const { root, fs } = await setup();
    const dir = path.join(root, 'created');
    await fs.createDirectory(dir);
    const file = path.join(dir, 'note.txt');
    await fs.writeFile(file, 'hello', 'rewrite');
    await fs.writeFile(file, ' world', 'append');
    const edited = await fs.editFile(file, 'world', 'Agent Core', 1);
    expect(edited.replacements).toBe(1);
    expect(await readFile(file, 'utf8')).toBe('hello Agent Core');

    const moved = path.join(root, 'moved.txt');
    await fs.moveFile(file, moved);
    const info = await fs.getFileInfo(moved);
    expect(info.type).toBe('file');
    expect(info.size).toBeGreaterThan(0);
  });

  it('rejects outside-root access and ambiguous edits', async () => {
    const { root, outside, fs } = await setup();
    await writeFile(path.join(outside, 'secret.txt'), 'hidden');
    await writeFile(path.join(root, 'dupe.txt'), 'x x');

    await expect(fs.readFile(path.join(outside, 'secret.txt'))).rejects.toThrow(/outside allowed roots/i);
    await expect(fs.editFile(path.join(root, 'dupe.txt'), 'x', 'y', 1)).rejects.toThrow(/expected 1 replacement/i);
  });
});
