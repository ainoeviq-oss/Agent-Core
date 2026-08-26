import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { WorkspacePolicy } from '../runtime/workspace.js';
import type { ExecutionArtifactKind, ValidatedExecutionArtifact } from './dag.js';

export type ExecutionEvidenceState = 'not_declared' | 'verified' | 'failed';
export type ExecutionArtifactVerification = 'verified' | 'missing' | 'type_mismatch';

export interface ExecutionArtifactEvidence {
  path: string;
  kind: ExecutionArtifactKind;
  required: boolean;
  exists: boolean;
  verification: ExecutionArtifactVerification;
  actualKind?: ExecutionArtifactKind | 'other';
  size?: number;
  modifiedAt?: number;
  sha256?: string;
}

export interface ExecutionEvidenceManifest {
  verification: ExecutionEvidenceState;
  artifacts: ExecutionArtifactEvidence[];
  error?: string;
}

function actualKind(info: Awaited<ReturnType<typeof stat>>): ExecutionArtifactKind | 'other' {
  if (info.isFile()) return 'file';
  if (info.isDirectory()) return 'directory';
  return 'other';
}

async function fileSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function verifyExecutionArtifacts(
  workspace: WorkspacePolicy,
  declarations: readonly ValidatedExecutionArtifact[],
): Promise<ExecutionEvidenceManifest> {
  if (declarations.length === 0) return { verification: 'not_declared', artifacts: [] };

  const artifacts: ExecutionArtifactEvidence[] = [];
  let failed = false;
  for (const declaration of declarations) {
    let resolved: string;
    try {
      resolved = await workspace.resolveExisting(declaration.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const missing: ExecutionArtifactEvidence = {
        path: declaration.path,
        kind: declaration.kind,
        required: declaration.required,
        exists: false,
        verification: 'missing',
      };
      artifacts.push(missing);
      if (declaration.required) failed = true;
      continue;
    }

    const info = await stat(resolved);
    const observedKind = actualKind(info);
    if (observedKind !== declaration.kind) {
      artifacts.push({
        path: declaration.path,
        kind: declaration.kind,
        required: declaration.required,
        exists: true,
        verification: 'type_mismatch',
        actualKind: observedKind,
        modifiedAt: info.mtimeMs,
      });
      if (declaration.required) failed = true;
      continue;
    }

    artifacts.push({
      path: declaration.path,
      kind: declaration.kind,
      required: declaration.required,
      exists: true,
      verification: 'verified',
      actualKind: observedKind,
      ...(observedKind === 'file' ? { size: info.size } : {}),
      modifiedAt: info.mtimeMs,
      ...(declaration.hash === 'sha256' && observedKind === 'file'
        ? { sha256: await fileSha256(resolved) }
        : {}),
    });
  }

  return {
    verification: failed ? 'failed' : 'verified',
    artifacts,
  };
}
