import fs from 'node:fs/promises';
import path from 'node:path';

import { PACKAGE_ROOT, WORKSPACES_ROOT } from './constants.js';
import { CodespaceError } from './errors.js';

export function assertInside(root: string, candidate: string): string {
  const relative = path.relative(root, candidate);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return candidate;
  }
  throw new CodespaceError(
    'PATH_OUTSIDE_WORKSPACE',
    'Requested path escapes the active workspace.',
  );
}

async function canonicalDirectory(candidate: string, allowedBase: string): Promise<string> {
  const canonicalBase = await fs.realpath(allowedBase);
  const canonicalCandidate = await fs.realpath(candidate);
  assertInside(canonicalBase, canonicalCandidate);
  const stat = await fs.stat(canonicalCandidate);
  if (!stat.isDirectory()) {
    throw new CodespaceError('WORKSPACE_UNAVAILABLE', 'Workspace root is not a directory.');
  }
  return canonicalCandidate;
}

async function findRepositoryRoot(start: string, allowedBase: string): Promise<string | undefined> {
  const canonicalBase = await fs.realpath(allowedBase);
  let current = await fs.realpath(start);
  assertInside(canonicalBase, current);

  while (true) {
    try {
      await fs.access(path.join(current, '.git'));
      return current;
    } catch {
      // Keep walking toward the allowed base.
    }

    if (current === canonicalBase) return undefined;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    assertInside(canonicalBase, parent);
    current = parent;
  }
}

export async function resolveWorkspaceRoot(
  allowedBase: string = WORKSPACES_ROOT,
): Promise<string> {
  const explicit = process.env.CODESPACE_WORKSPACE_ROOT;
  if (explicit) return canonicalDirectory(explicit, allowedBase);

  try {
    const packageRepository = await findRepositoryRoot(PACKAGE_ROOT, allowedBase);
    if (packageRepository) return packageRepository;
  } catch {
    // Fall through to direct repository discovery below.
  }

  const canonicalBase = await fs.realpath(allowedBase);
  const entries = await fs.readdir(canonicalBase, { withFileTypes: true });
  const candidates: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(canonicalBase, entry.name);
    try {
      await fs.access(path.join(candidate, '.git'));
      candidates.push(await canonicalDirectory(candidate, canonicalBase));
    } catch {
      // Not a repository candidate.
    }
  }

  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1) {
    throw new CodespaceError(
      'WORKSPACE_AMBIGUOUS',
      'Multiple repository workspaces were found under /workspaces.',
      { candidates },
    );
  }
  throw new CodespaceError('WORKSPACE_UNAVAILABLE', 'No repository workspace was found.');
}

export async function resolveExistingPath(
  root: string,
  requestedPath: string,
  allowedBase: string = WORKSPACES_ROOT,
): Promise<string> {
  const canonicalRoot = await canonicalDirectory(root, allowedBase);
  const lexicalCandidate = path.resolve(canonicalRoot, requestedPath);
  assertInside(canonicalRoot, lexicalCandidate);
  const canonicalCandidate = await fs.realpath(lexicalCandidate);
  return assertInside(canonicalRoot, canonicalCandidate);
}

export async function resolveTargetPath(
  root: string,
  requestedPath: string,
  allowedBase: string = WORKSPACES_ROOT,
): Promise<string> {
  const canonicalRoot = await canonicalDirectory(root, allowedBase);
  const target = path.resolve(canonicalRoot, requestedPath);
  assertInside(canonicalRoot, target);

  let probe = target;
  while (true) {
    try {
      const canonicalAncestor = await fs.realpath(probe);
      assertInside(canonicalRoot, canonicalAncestor);
      return target;
    } catch (error) {
      if (error instanceof CodespaceError) throw error;
      if (probe === canonicalRoot) throw error;
      const parent = path.dirname(probe);
      if (parent === probe) throw error;
      probe = parent;
    }
  }
}
