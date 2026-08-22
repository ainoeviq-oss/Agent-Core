import {
  appendFile,
  mkdir,
  readFile as fsReadFile,
  readdir,
  rename,
  stat,
  writeFile as fsWriteFile,
} from 'node:fs/promises';
import path from 'node:path';
import type { WorkspacePolicy } from './workspace.js';

export type FileEntryType = 'file' | 'directory' | 'symlink' | 'other';
export interface FileEntry { path: string; name: string; type: FileEntryType; size?: number }
export interface ReadOptions { startLine?: number; lineCount?: number; maxBytes?: number }

function entryType(dirent: import('node:fs').Dirent): FileEntryType {
  if (dirent.isFile()) return 'file';
  if (dirent.isDirectory()) return 'directory';
  if (dirent.isSymbolicLink()) return 'symlink';
  return 'other';
}

export class FileSystemService {
  constructor(private readonly workspace: WorkspacePolicy) {}

  async listDirectory(target: string, depth = 1, maxEntries = 500): Promise<{ path: string; entries: FileEntry[]; truncated: boolean }> {
    const root = await this.workspace.resolveExisting(target);
    const entries: FileEntry[] = [];
    const boundedDepth = Math.max(1, Math.min(depth, 10));
    const walk = async (dir: string, level: number): Promise<void> => {
      const items = await readdir(dir, { withFileTypes: true });
      items.sort((a, b) => a.name.localeCompare(b.name));
      for (const item of items) {
        if (entries.length >= maxEntries) return;
        const full = path.join(dir, item.name);
        const type = entryType(item);
        const metadata = type === 'file' ? await stat(full) : null;
        entries.push({ path: full, name: item.name, type, ...(metadata ? { size: metadata.size } : {}) });
        if (type === 'directory' && level < boundedDepth) await walk(full, level + 1);
      }
    };

    await walk(root, 1);
    return { path: root, entries, truncated: entries.length >= maxEntries };
  }

  async readFile(target: string, options: ReadOptions = {}): Promise<{ path: string; content: string; truncated: boolean; bytes: number }> {
    const file = await this.workspace.resolveExisting(target);
    const buffer = await fsReadFile(file);
    const maxBytes = Math.max(1, options.maxBytes ?? 1024 * 1024);
    const truncated = buffer.length > maxBytes;
    const content = buffer.subarray(0, maxBytes).toString('utf8');
    if (options.startLine === undefined && options.lineCount === undefined) {
      return { path: file, content, truncated, bytes: buffer.length };
    }
    const lines = content.split(/\r?\n/);
    const start = Math.max(0, options.startLine ?? 0);
    const count = Math.max(0, options.lineCount ?? lines.length - start);
    return { path: file, content: lines.slice(start, start + count).join('\n'), truncated, bytes: buffer.length };
  }

  async readMultipleFiles(targets: string[], options: ReadOptions = {}): Promise<{ files: Array<{ path: string; content: string; truncated: boolean; bytes: number }> }> {
    const files = [];
    for (const target of targets) files.push(await this.readFile(target, options));
    return { files };
  }

  async writeFile(target: string, content: string, mode: 'rewrite' | 'append' = 'rewrite'): Promise<{ path: string; bytesWritten: number; mode: string }> {
    const file = await this.workspace.resolveTarget(target);
    await mkdir(path.dirname(file), { recursive: true });
    if (mode === 'append') await appendFile(file, content, 'utf8');
    else await fsWriteFile(file, content, 'utf8');
    return { path: file, bytesWritten: Buffer.byteLength(content), mode };
  }

  async editFile(target: string, oldString: string, newString: string, expectedReplacements = 1): Promise<{ path: string; replacements: number }> {
    if (!oldString) throw new Error('oldString must not be empty');
    const file = await this.workspace.resolveExisting(target);
    const content = await fsReadFile(file, 'utf8');
    const replacements = content.split(oldString).length - 1;
    if (replacements !== expectedReplacements) {
      throw new Error(`Expected ${expectedReplacements} replacement(s), found ${replacements}`);
    }
    await fsWriteFile(file, content.split(oldString).join(newString), 'utf8');
    return { path: file, replacements };
  }

  async createDirectory(target: string): Promise<{ path: string; created: true }> {
    const dir = await this.workspace.resolveTarget(target);
    await mkdir(dir, { recursive: true });
    return { path: dir, created: true };
  }

  async moveFile(source: string, destination: string): Promise<{ source: string; destination: string }> {
    const from = await this.workspace.resolveExisting(source);
    const to = await this.workspace.resolveTarget(destination);
    await mkdir(path.dirname(to), { recursive: true });
    await rename(from, to);
    return { source: from, destination: to };
  }

  async getFileInfo(target: string): Promise<{ path: string; type: 'file' | 'directory' | 'other'; size: number; createdAt: string; modifiedAt: string }> {
    const resolved = await this.workspace.resolveExisting(target);
    const info = await stat(resolved);
    const type = info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other';
    return { path: resolved, type, size: info.size, createdAt: info.birthtime.toISOString(), modifiedAt: info.mtime.toISOString() };
  }
}
