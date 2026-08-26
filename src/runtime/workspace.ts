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

function textCanonical(value: string): string {
  const normalized = value.normalize('NFKC');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
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

export type WorkspaceProjectErrorCode =
  | 'WORKSPACE_PROJECT_AMBIGUOUS'
  | 'WORKSPACE_PROJECT_NOT_ALLOWED'
  | 'WORKSPACE_PROJECT_MISMATCH';

export class WorkspaceProjectError extends Error {
  constructor(public readonly code: WorkspaceProjectErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'WorkspaceProjectError';
  }
}

export interface ProjectResolutionInput {
  explicitRoot?: string;
  candidatePaths?: string[];
  texts?: Array<string | undefined>;
}

export class WorkspacePolicy {
  readonly roots: string[];

  constructor(roots: string[]) {
    const normalized = roots.map((root) => path.resolve(root.trim())).filter(Boolean);
    if (!normalized.length) throw new Error('At least one Agent Core workspace root is required');
    this.roots = [...new Set(normalized)];
  }

  isAllowed(target: string): boolean {
    const resolved = path.resolve(target);
    return this.roots.some((root) => inside(root, resolved));
  }

  resolveProjectRoot(input: ProjectResolutionInput = {}): string {
    const evidence = new Set<string>();

    if (input.explicitRoot?.trim()) {
      const match = this.projectForPath(input.explicitRoot);
      if (!match) {
        throw new WorkspaceProjectError(
          'WORKSPACE_PROJECT_NOT_ALLOWED',
          `Explicit project root is outside configured workspace roots: ${input.explicitRoot}`,
        );
      }
      evidence.add(match);
    }

    for (const candidate of input.candidatePaths ?? []) {
      if (typeof candidate !== 'string' || !candidate.trim() || !path.isAbsolute(candidate)) continue;
      const match = this.projectForPath(candidate);
      if (match) evidence.add(match);
    }

    for (const text of input.texts ?? []) {
      if (!text?.trim()) continue;
      const haystack = textCanonical(text).replaceAll('\\', '/');
      for (const root of this.roots) {
        const needle = textCanonical(path.resolve(root)).replaceAll('\\', '/');
        if (haystack.includes(needle)) evidence.add(root);
      }
    }

    if (evidence.size === 1) return [...evidence][0]!;
    if (evidence.size > 1) {
      throw new WorkspaceProjectError(
        'WORKSPACE_PROJECT_AMBIGUOUS',
        `Project evidence matched multiple workspace roots: ${[...evidence].join(', ')}`,
      );
    }
    if (this.roots.length === 1) return this.roots[0]!;
    throw new WorkspaceProjectError(
      'WORKSPACE_PROJECT_AMBIGUOUS',
      'Multiple workspace roots are configured and no unique project root was identified',
    );
  }

  async resolveExistingInProject(projectRoot: string, target: string): Promise<string> {
    const project = this.requireProjectRoot(projectRoot);
    const resolved = this.assertLexicalInProject(project, target);
    await this.assertRealWithin(project, resolved);
    return resolved;
  }

  async resolveTargetInProject(projectRoot: string, target: string): Promise<string> {
    const project = this.requireProjectRoot(projectRoot);
    const resolved = this.assertLexicalInProject(project, target);
    const parent = await nearestExistingParent(resolved);
    await this.assertRealWithin(project, parent);
    return resolved;
  }

  private projectForPath(target: string): string | undefined {
    const resolved = path.resolve(target);
    const matches = this.roots.filter((root) => inside(root, resolved));
    if (matches.length === 0) return undefined;
    return matches.sort((left, right) => canonical(right).length - canonical(left).length)[0];
  }

  private requireProjectRoot(projectRoot: string): string {
    const resolved = path.resolve(projectRoot);
    const exact = this.roots.find((root) => canonical(root) === canonical(resolved));
    if (!exact) {
      throw new WorkspaceProjectError(
        'WORKSPACE_PROJECT_NOT_ALLOWED',
        `Project root is not one of the configured workspace roots: ${projectRoot}`,
      );
    }
    return exact;
  }

  private assertLexical(target: string): string {
    const resolved = path.resolve(target);
    if (!this.isAllowed(resolved)) throw new Error(`Path is outside allowed roots: ${target}`);
    return resolved;
  }

  private assertLexicalInProject(projectRoot: string, target: string): string {
    const resolved = path.resolve(target);
    if (!inside(projectRoot, resolved)) {
      throw new WorkspaceProjectError(
        'WORKSPACE_PROJECT_MISMATCH',
        `Path is outside routed project ${projectRoot}: ${target}`,
      );
    }
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

  private async assertRealWithin(projectRoot: string, target: string): Promise<void> {
    const [realTarget, realProject] = await Promise.all([
      realpath(target),
      realpath(projectRoot).catch(() => path.resolve(projectRoot)),
    ]);
    if (!inside(realProject, realTarget)) {
      throw new WorkspaceProjectError(
        'WORKSPACE_PROJECT_MISMATCH',
        `Resolved path is outside routed project ${projectRoot}: ${target}`,
      );
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
