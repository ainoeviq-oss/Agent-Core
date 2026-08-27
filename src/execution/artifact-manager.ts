import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { WorkspacePolicy } from '../runtime/workspace.js';
import type { RuntimeMetricRegistry } from '../runtime/metric-window.js';
import type { ExecutionArtifactType } from './dag.js';
import type { ExecutionLogStore } from './log-store.js';
import { stableExecutionJson, type ExecutionStore } from './store.js';
import type { ExecutionScope } from './types.js';

export interface IndexedExecutionArtifact {
  artifactId: string;
  runId: string;
  nodeId: string;
  attemptNo: number;
  path: string;
  artifactType: ExecutionArtifactType;
  verification: 'verified';
  sha256?: string;
  size?: number;
  modifiedAt?: number;
  sourceResultRef: string;
  createdAt: number;
}

export interface ArtifactReuseResult {
  found: boolean;
  advisoryOnly: true;
  stillExists?: boolean;
  stillVerified?: boolean;
  artifact?: IndexedExecutionArtifact;
}

export interface PurgeSuggestion extends IndexedExecutionArtifact {
  reason: string;
  safeToReview: true;
}

type ArtifactRow = {
  artifact_id: string;
  run_id: string;
  node_id: string;
  attempt_no: number;
  path: string;
  artifact_type: ExecutionArtifactType;
  verification: 'verified';
  sha256: string | null;
  size: number | null;
  modified_at: number | null;
  source_result_ref: string;
  created_at: number;
};

function mapArtifact(row: ArtifactRow): IndexedExecutionArtifact {
  return {
    artifactId: row.artifact_id,
    runId: row.run_id,
    nodeId: row.node_id,
    attemptNo: Number(row.attempt_no),
    path: row.path,
    artifactType: row.artifact_type,
    verification: 'verified',
    ...(row.sha256 ? { sha256: row.sha256 } : {}),
    ...(row.size == null ? {} : { size: Number(row.size) }),
    ...(row.modified_at == null ? {} : { modifiedAt: Number(row.modified_at) }),
    sourceResultRef: row.source_result_ref,
    createdAt: Number(row.created_at),
  };
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export class ExecutionArtifactManager {
  constructor(
    readonly store: ExecutionStore,
    readonly workspace: WorkspacePolicy,
    readonly logs?: ExecutionLogStore,
    readonly metrics?: RuntimeMetricRegistry,
  ) {}

  async indexAttempt(scope: ExecutionScope, runId: string, nodeId: string, attemptNo: number): Promise<IndexedExecutionArtifact[]> {
    const started = performance.now();
    try {
      await this.store.getRun(scope, runId).then((run) => {
        if (!run) throw new Error('EXECUTION_RUN_NOT_FOUND');
      });
      const existing = await this.findByRun(scope, runId, nodeId, attemptNo);
      if (existing.length > 0) return existing;
      if (!this.logs) return [];
      const marker = await this.logs.readResult(runId, nodeId, attemptNo);
      if (!marker || marker.version !== 2 || marker.evidenceState !== 'verified' || marker.evidence.verification !== 'verified') return [];
      const attempt = (await this.store.listAttempts(scope, runId, nodeId)).find((item) => item.attemptNo === attemptNo);
      if (!attempt) return [];
      const now = Date.now();
      const operations = marker.evidence.artifacts
        .filter((artifact) => artifact.verification === 'verified' && artifact.exists)
        .sort((left, right) => left.path.localeCompare(right.path))
        .map((artifact) => ({
          kind: 'run' as const,
          sql: `INSERT OR IGNORE INTO execution_artifacts(
            artifact_id,run_id,node_id,attempt_no,path,artifact_type,verification,sha256,size,modified_at,
            source_result_ref,metadata_json,created_at
          ) VALUES (?,?,?,?,?,?, 'verified',?,?,?,?,?,?)`,
          params: [
            randomUUID(), runId, nodeId, attemptNo, artifact.path, artifact.artifactType ?? 'other',
            artifact.sha256 ?? null, artifact.size ?? null, artifact.modifiedAt ?? null,
            attempt.resultPath,
            stableExecutionJson({ required: artifact.required, actualKind: artifact.actualKind ?? null }),
            now,
          ],
        }));
      if (operations.length > 0) await this.store.client.transaction(operations);
      return this.findByRun(scope, runId, nodeId, attemptNo);
    } catch (error) {
      this.metrics?.failure('execution.artifact_index.duration_ms', error instanceof Error ? error.name : 'EXECUTION_ARTIFACT_INDEX_FAILED');
      throw error;
    } finally {
      this.metrics?.observe('execution.artifact_index.duration_ms', Math.max(0, performance.now() - started));
    }
  }

  async findByHash(scope: ExecutionScope, hash: string): Promise<IndexedExecutionArtifact[]> {
    const normalized = hash.toLowerCase().trim();
    if (!/^[a-f0-9]{64}$/.test(normalized)) return [];
    return this.query(scope, 'artifact.sha256 = ?', [normalized]);
  }

  async findByType(scope: ExecutionScope, artifactType: ExecutionArtifactType): Promise<IndexedExecutionArtifact[]> {
    if (!['build', 'test_report', 'log', 'data', 'other'].includes(artifactType)) return [];
    return this.query(scope, 'artifact.artifact_type = ?', [artifactType]);
  }

  async findByRun(scope: ExecutionScope, runId: string, nodeId?: string, attemptNo?: number): Promise<IndexedExecutionArtifact[]> {
    const clauses = ['artifact.run_id = ?'];
    const params: Array<string | number> = [runId];
    if (nodeId) { clauses.push('artifact.node_id = ?'); params.push(nodeId); }
    if (attemptNo !== undefined) { clauses.push('artifact.attempt_no = ?'); params.push(attemptNo); }
    return this.query(scope, clauses.join(' AND '), params);
  }

  async findReusable(
    scope: ExecutionScope,
    input: { sha256: string; excludeRunId?: string },
  ): Promise<ArtifactReuseResult> {
    const candidates = await this.findByHash(scope, input.sha256);
    for (const candidate of candidates) {
      if (input.excludeRunId && candidate.runId === input.excludeRunId) continue;
      if (!candidate.sha256) continue;
      try {
        const resolved = await this.workspace.resolveExisting(candidate.path);
        const info = await stat(resolved);
        if (!info.isFile()) continue;
        if (await sha256(resolved) !== candidate.sha256) continue;
        return { found: true, advisoryOnly: true, stillExists: true, stillVerified: true, artifact: candidate };
      } catch {
        continue;
      }
    }
    return { found: false, advisoryOnly: true };
  }

  async suggestPurge(scope: ExecutionScope, options: { olderThanMs?: number; limit?: number } = {}): Promise<PurgeSuggestion[]> {
    const olderThanMs = Math.max(0, options.olderThanMs ?? 30 * 24 * 60 * 60 * 1000);
    const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
    const cutoff = Date.now() - olderThanMs;
    const rows = await this.store.client.query<ArtifactRow>(
      `SELECT artifact.artifact_id, artifact.run_id, artifact.node_id, artifact.attempt_no, artifact.path,
              artifact.artifact_type, artifact.verification, artifact.sha256, artifact.size, artifact.modified_at,
              artifact.source_result_ref, artifact.created_at
         FROM execution_artifacts AS artifact
         JOIN execution_runs AS run ON run.id = artifact.run_id
        WHERE run.principal_id = ? AND IFNULL(run.project_id, '') = ?
          AND run.state IN ('completed','failed','blocked','interrupted','cancelled')
          AND artifact.created_at <= ?
        ORDER BY artifact.created_at ASC, artifact.artifact_id ASC
        LIMIT ?`,
      [scope.principalId, scope.projectId ?? '', cutoff, limit],
    );
    return rows.map((row) => ({ ...mapArtifact(row), reason: `terminal artifact older than or equal to ${olderThanMs} ms; review only`, safeToReview: true }));
  }

  private async query(
    scope: ExecutionScope,
    where: string,
    params: Array<string | number>,
  ): Promise<IndexedExecutionArtifact[]> {
    const rows = await this.store.client.query<ArtifactRow>(
      `SELECT artifact.artifact_id, artifact.run_id, artifact.node_id, artifact.attempt_no, artifact.path,
              artifact.artifact_type, artifact.verification, artifact.sha256, artifact.size, artifact.modified_at,
              artifact.source_result_ref, artifact.created_at
         FROM execution_artifacts AS artifact
         JOIN execution_runs AS run ON run.id = artifact.run_id
        WHERE run.principal_id = ? AND IFNULL(run.project_id, '') = ? AND ${where}
        ORDER BY artifact.created_at DESC, artifact.artifact_id ASC`,
      [scope.principalId, scope.projectId ?? '', ...params],
    );
    return rows.map(mapArtifact);
  }
}
