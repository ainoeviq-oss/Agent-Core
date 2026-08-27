import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  editTextFile,
  listDirectory,
  readMultipleFiles,
  readTextFile,
  searchFiles,
  writeTextFile,
} from '../src/filesystem.js';

let base: string;
let root: string;

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'codespace-fs-'));
  root = path.join(base, 'repo');
  await fs.mkdir(root);
});

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

describe('bounded filesystem operations', () => {
  it('writes and reads utf8 inside the workspace', async () => {
    await writeTextFile(root, {
      path: 'nested/value.txt',
      content: 'hello',
      mode: 'rewrite',
    }, base);

    const value = await readTextFile(root, { path: 'nested/value.txt' }, base);
    expect(value.text).toBe('hello');
  });

  it('rejects ambiguous exact edits', async () => {
    await fs.writeFile(path.join(root, 'a.txt'), 'same same');

    await expect(editTextFile(root, {
      path: 'a.txt',
      oldString: 'same',
      newString: 'new',
      expectedReplacements: 1,
    }, base)).rejects.toMatchObject({ code: 'EDIT_MATCH_COUNT_MISMATCH' });
  });

  it('caps content search results', async () => {
    for (let index = 0; index < 5; index += 1) {
      await fs.writeFile(path.join(root, `match-${index}.txt`), 'needle');
    }

    const result = await searchFiles(root, {
      query: 'needle',
      mode: 'content',
      maxResults: 2,
    }, base);

    expect(result.matches).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('lists entries without following symlinks outside the workspace', async () => {
    const outside = path.join(base, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'secret.txt'), 'hidden');
    await fs.symlink(outside, path.join(root, 'escape'));
    await fs.writeFile(path.join(root, 'visible.txt'), 'ok');

    const result = await listDirectory(root, { path: '.', depth: 2, maxResults: 20 }, base);
    expect(result.entries.some((entry) => entry.path === 'visible.txt')).toBe(true);
    expect(result.entries.some((entry) => entry.path === 'escape/secret.txt')).toBe(false);
  });

  it('reads multiple files with a bounded batch size', async () => {
    await fs.writeFile(path.join(root, 'one.txt'), 'one');
    await fs.writeFile(path.join(root, 'two.txt'), 'two');

    const result = await readMultipleFiles(root, ['one.txt', 'two.txt'], base);
    expect(result.files.map((file) => file.text)).toEqual(['one', 'two']);

    await expect(readMultipleFiles(root, Array.from({ length: 51 }, (_, index) => `f-${index}.txt`), base))
      .rejects.toMatchObject({ code: 'INVALID_BATCH_SIZE' });
  });
});
