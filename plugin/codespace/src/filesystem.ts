import fs from 'node:fs/promises';
import path from 'node:path';

import { MAX_TEXT_BYTES, WORKSPACES_ROOT } from './constants.js';
import { CodespaceError } from './errors.js';
import { resolveExistingPath, resolveTargetPath } from './workspace.js';

const decoder = new TextDecoder('utf-8', { fatal: true });

export interface FileReadResult {
  path: string;
  text: string;
  bytes: number;
}

export interface DirectoryEntry {
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size?: number;
}

async function readUtf8File(filePath: string): Promise<{ text: string; bytes: number }> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    throw new CodespaceError('NOT_A_FILE', 'Requested path is not a regular file.');
  }
  if (stat.size > MAX_TEXT_BYTES) {
    throw new CodespaceError('FILE_TOO_LARGE', `Text files are limited to ${MAX_TEXT_BYTES} bytes.`);
  }

  const buffer = await fs.readFile(filePath);
  try {
    return { text: decoder.decode(buffer), bytes: buffer.byteLength };
  } catch {
    throw new CodespaceError('INVALID_UTF8', 'Requested file is not valid UTF-8 text.');
  }
}

export async function readTextFile(
  root: string,
  input: { path: string },
  allowedBase: string = WORKSPACES_ROOT,
): Promise<FileReadResult> {
  const filePath = await resolveExistingPath(root, input.path, allowedBase);
  const value = await readUtf8File(filePath);
  return { path: input.path, ...value };
}

export async function readMultipleFiles(
  root: string,
  paths: string[],
  allowedBase: string = WORKSPACES_ROOT,
): Promise<{ files: FileReadResult[] }> {
  if (paths.length < 1 || paths.length > 50) {
    throw new CodespaceError('INVALID_BATCH_SIZE', 'readMultipleFiles accepts between 1 and 50 paths.');
  }
  const files: FileReadResult[] = [];
  for (const filePath of paths) {
    files.push(await readTextFile(root, { path: filePath }, allowedBase));
  }
  return { files };
}

export async function writeTextFile(
  root: string,
  input: { path: string; content: string; mode?: 'rewrite' | 'append' },
  allowedBase: string = WORKSPACES_ROOT,
): Promise<{ path: string; bytes: number }> {
  const target = await resolveTargetPath(root, input.path, allowedBase);
  const bytes = Buffer.byteLength(input.content, 'utf8');
  if (bytes > MAX_TEXT_BYTES) {
    throw new CodespaceError('FILE_TOO_LARGE', `Text files are limited to ${MAX_TEXT_BYTES} bytes.`);
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (input.mode === 'append') {
    await fs.appendFile(target, input.content, 'utf8');
  } else {
    await fs.writeFile(target, input.content, 'utf8');
  }
  return { path: input.path, bytes };
}

export async function editTextFile(
  root: string,
  input: {
    path: string;
    oldString: string;
    newString: string;
    expectedReplacements: number;
  },
  allowedBase: string = WORKSPACES_ROOT,
): Promise<{ path: string; replacements: number; bytes: number }> {
  if (input.oldString.length === 0) {
    throw new CodespaceError('INVALID_EDIT', 'oldString must not be empty.');
  }
  const target = await resolveExistingPath(root, input.path, allowedBase);
  const current = await readUtf8File(target);
  const actualMatches = current.text.split(input.oldString).length - 1;
  if (actualMatches !== input.expectedReplacements) {
    throw new CodespaceError(
      'EDIT_MATCH_COUNT_MISMATCH',
      `Expected ${input.expectedReplacements} exact matches but found ${actualMatches}.`,
      { expectedReplacements: input.expectedReplacements, actualMatches },
    );
  }

  const next = current.text.split(input.oldString).join(input.newString);
  const bytes = Buffer.byteLength(next, 'utf8');
  if (bytes > MAX_TEXT_BYTES) {
    throw new CodespaceError('FILE_TOO_LARGE', `Text files are limited to ${MAX_TEXT_BYTES} bytes.`);
  }
  await fs.writeFile(target, next, 'utf8');
  return { path: input.path, replacements: actualMatches, bytes };
}

async function safeEntry(
  root: string,
  absolutePath: string,
  relativePath: string,
  allowedBase: string,
): Promise<{ entry: DirectoryEntry; descend?: string } | undefined> {
  const lstat = await fs.lstat(absolutePath);
  if (lstat.isSymbolicLink()) {
    try {
      const resolved = await resolveExistingPath(root, relativePath, allowedBase);
      const stat = await fs.stat(resolved);
      return {
        entry: { path: relativePath, type: 'symlink', size: stat.isFile() ? stat.size : undefined },
        descend: stat.isDirectory() ? resolved : undefined,
      };
    } catch (error) {
      if (error instanceof CodespaceError && error.code === 'PATH_OUTSIDE_WORKSPACE') {
        return { entry: { path: relativePath, type: 'symlink' } };
      }
      throw error;
    }
  }
  if (lstat.isDirectory()) return { entry: { path: relativePath, type: 'directory' }, descend: absolutePath };
  if (lstat.isFile()) return { entry: { path: relativePath, type: 'file', size: lstat.size } };
  return { entry: { path: relativePath, type: 'other' } };
}

export async function listDirectory(
  root: string,
  input: { path?: string; depth?: number; maxResults?: number },
  allowedBase: string = WORKSPACES_ROOT,
): Promise<{ entries: DirectoryEntry[]; truncated: boolean }> {
  const startRequest = input.path ?? '.';
  const start = await resolveExistingPath(root, startRequest, allowedBase);
  const startStat = await fs.stat(start);
  if (!startStat.isDirectory()) {
    throw new CodespaceError('NOT_A_DIRECTORY', 'Requested path is not a directory.');
  }

  const depth = Math.max(1, Math.min(input.depth ?? 1, 20));
  const maxResults = Math.max(1, Math.min(input.maxResults ?? 200, 5000));
  const entries: DirectoryEntry[] = [];
  let truncated = false;
  const seenDirectories = new Set<string>();

  const walk = async (directory: string, currentDepth: number): Promise<void> => {
    const canonicalDirectory = await fs.realpath(directory);
    if (seenDirectories.has(canonicalDirectory)) return;
    seenDirectories.add(canonicalDirectory);

    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      if (entries.length >= maxResults) {
        truncated = true;
        return;
      }
      const absolute = path.join(directory, child.name);
      const relative = path.relative(await fs.realpath(root), absolute).split(path.sep).join('/');
      const safe = await safeEntry(root, absolute, relative, allowedBase);
      if (!safe) continue;
      entries.push(safe.entry);
      if (safe.descend && currentDepth < depth) {
        await walk(safe.descend, currentDepth + 1);
        if (truncated) return;
      }
    }
  };

  await walk(start, 1);
  return { entries, truncated };
}

export async function searchFiles(
  root: string,
  input: { query: string; mode?: 'filename' | 'content'; path?: string; maxResults?: number },
  allowedBase: string = WORKSPACES_ROOT,
): Promise<{ matches: Array<{ path: string; line?: number; text?: string }>; truncated: boolean }> {
  if (!input.query) {
    throw new CodespaceError('INVALID_SEARCH_QUERY', 'Search query must not be empty.');
  }

  const startRequest = input.path ?? '.';
  const start = await resolveExistingPath(root, startRequest, allowedBase);
  const maxResults = Math.max(1, Math.min(input.maxResults ?? 100, 5000));
  const mode = input.mode ?? 'filename';
  const canonicalRoot = await fs.realpath(root);
  const matches: Array<{ path: string; line?: number; text?: string }> = [];
  let truncated = false;
  const seenDirectories = new Set<string>();

  const add = (match: { path: string; line?: number; text?: string }): boolean => {
    if (matches.length >= maxResults) {
      truncated = true;
      return false;
    }
    matches.push(match);
    return true;
  };

  const visitFile = async (absolute: string): Promise<void> => {
    const relative = path.relative(canonicalRoot, absolute).split(path.sep).join('/');
    if (mode === 'filename') {
      if (path.basename(relative).includes(input.query)) add({ path: relative });
      return;
    }
    let value: { text: string; bytes: number };
    try {
      value = await readUtf8File(absolute);
    } catch (error) {
      if (error instanceof CodespaceError && ['FILE_TOO_LARGE', 'INVALID_UTF8', 'NOT_A_FILE'].includes(error.code)) return;
      throw error;
    }
    const lines = value.text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      if (line.includes(input.query) && !add({ path: relative, line: index + 1, text: line })) return;
    }
  };

  const walk = async (directory: string): Promise<void> => {
    const canonicalDirectory = await fs.realpath(directory);
    if (seenDirectories.has(canonicalDirectory)) return;
    seenDirectories.add(canonicalDirectory);
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      if (truncated) return;
      const absolute = path.join(directory, child.name);
      const relative = path.relative(canonicalRoot, absolute).split(path.sep).join('/');
      if (child.isSymbolicLink()) {
        let resolved: string;
        try {
          resolved = await resolveExistingPath(root, relative, allowedBase);
        } catch (error) {
          if (error instanceof CodespaceError && error.code === 'PATH_OUTSIDE_WORKSPACE') continue;
          throw error;
        }
        const stat = await fs.stat(resolved);
        if (stat.isDirectory()) await walk(resolved);
        else if (stat.isFile()) await visitFile(resolved);
      } else if (child.isDirectory()) {
        await walk(absolute);
      } else if (child.isFile()) {
        await visitFile(absolute);
      }
    }
  };

  const startStat = await fs.stat(start);
  if (startStat.isDirectory()) await walk(start);
  else if (startStat.isFile()) await visitFile(start);
  else throw new CodespaceError('INVALID_SEARCH_ROOT', 'Search root must be a file or directory.');

  return { matches, truncated };
}
