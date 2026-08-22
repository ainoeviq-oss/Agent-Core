import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

function canonical(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function inside(root: string, candidate: string): boolean {
  const base = canonical(root);
  const target = canonical(candidate);
  return target === base || target.startsWith(`${base}${path.sep}`);
}

async function nearestExistingParent(target: string): Promise<string> {
  let current = path.resolve(target);
  while (true) {
    try {
      await stat(current);
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw new Error(`No existing parent for path: ${target}`);
      current = parent;
    }
  }
}
export class WorkspacePolicy {
  readonly roots: string[];

  constructor(roots: string[]) {
    const normalized = roots.map((root) => path.resolve(root.trim())).filter(Boolean);
    if (!normalized.length) throw new Error('At least one Commander workspace root is required');
    this.roots = [...new Set(normalized)];
  }

  isAllowed(target: string): boolean {
    const resolved = path.resolve(target);
    return this.roots.some((root) => inside(root, resolved));
  }

  private assertLexical(target: string): string {
    const resolved = path.resolve(target);
    if (!this.isAllowed(resolved)) throw new Error(`Path is outside allowed roots: ${target}`);
    return resolved;
  }

  private async assertReal(target: string): Promise<void> {
    const realTarget = await realpath(target);
    const realRoots = await Promise.all(this.roots.map(async (root) => {
      try { return await realpath(root); } catch { return path.resolve(root); }
    }));
    if (!realRoots.some((root) => inside(root, realTarget))) {
      throw new Error(`Path is outside allowed roots: ${target}`);
    }
  }

  async resolveExisting(target: string): Promise<string> {
    const resolved = this.assertLexical(target);
    await this.assertReal(resolved);
    return resolved;
  }

  async resolveTarget(target: string): Promise<string> {
    const resolved = this.assertLexical(target);
    const parent = await nearestExistingParent(resolved);
    await this.assertReal(parent);
    return resolved;
  }
}
