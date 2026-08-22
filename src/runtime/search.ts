import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { WorkspacePolicy } from './workspace.js';

export type SearchMode = 'files' | 'content';
export interface SearchRequest {
  path: string;
  query: string;
  mode: SearchMode;
  maxResults?: number;
}
export interface SearchMatch {
  path: string;
  line?: number;
  preview?: string;
}

export class SearchService {
  constructor(private readonly workspace: WorkspacePolicy) {}

  async search(request: SearchRequest): Promise<{ matches: SearchMatch[]; truncated: boolean }> {
    const root = await this.workspace.resolveExisting(request.path);
    const needle = request.query.toLocaleLowerCase();
    if (!needle) throw new Error('Search query must not be empty');
    const maxResults = Math.max(1, Math.min(request.maxResults ?? 100, 1000));
    const matches: SearchMatch[] = [];
    let truncated = false;
    const add = (match: SearchMatch): boolean => {
      if (matches.length >= maxResults) {
        truncated = true;
        return false;
      }
      matches.push(match);
      return true;
    };

    const walk = async (dir: string): Promise<boolean> => {
      const items = await readdir(dir, { withFileTypes: true });
      items.sort((a, b) => a.name.localeCompare(b.name));
      for (const item of items) {
        if (item.isSymbolicLink()) continue;
        const full = path.join(dir, item.name);
        if (item.isDirectory()) {
          if (!await walk(full)) return false;
          continue;
        }
        if (!item.isFile()) continue;
        if (request.mode === 'files') {
          if (item.name.toLocaleLowerCase().includes(needle) && !add({ path: full })) return false;
          continue;
        }
        if (!await this.searchContent(full, needle, add)) return false;
      }
      return true;
    };

    await walk(root);
    return { matches, truncated };
  }

  private async searchContent(
    file: string,
    needle: string,
    add: (match: SearchMatch) => boolean,
  ): Promise<boolean> {
    const info = await stat(file);
    if (info.size > 2 * 1024 * 1024) return true;
    const buffer = await readFile(file);
    if (buffer.includes(0)) return true;
    const lines = buffer.toString('utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? '';
      if (!line.toLocaleLowerCase().includes(needle)) continue;
      if (!add({ path: file, line: index + 1, preview: line.slice(0, 500) })) return false;
    }
    return true;
  }
}
