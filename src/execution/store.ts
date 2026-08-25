import { randomUUID } from 'node:crypto';
import type { ExecutionWorkerSqlOperation } from './db-worker.js';
import type { ValidatedExecutionNode } from './dag.js';
import type { ExecutionAttemptPaths, ExecutionResultMarker } from './log-store.js';
import { EXECUTION_SCHEMA_SQL, EXECUTION_SCHEMA_VERSION, INITIAL_EXECUTION_MIGRATION } from './schema.js';
import type { ExecutionAttemptState, ExecutionNodeState, ExecutionRunState, ExecutionScope } from './types.js';
import type { ExecutionEventFilter, ExecutionEventRecord, ExecutionEventType } from './wake.js';
import { ExecutionWorkerClient } from './worker-client.js';

export class ExecutionStoreError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ExecutionStoreError';
  }
}

export interface ExecutionStoreOpenResult {
  schemaVersion: number;
  quickCheck: string;
  integrity: string;
  integrityCheckedAt: number;
}

export interface ExecutionRunRecord {
  runId: string;
  principalId: string;
  projectId?: string;
  continuityTaskId?: string;
  originRouteContextId?: string;
  state: ExecutionRunState;
  objective: string;
  maxConcurrency: number;
  lastEventSequence: number;
  metadata: Record<string, unknown>;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  updatedAt: number;
}

export interface ExecutionNodeRecord {
  runId: string;
  nodeId: string;
  purpose: string;
  command: string;
  cwd: string;
  state: ExecutionNodeState;
  timeoutMs: number;
  continueOnFailure: boolean;
  attemptCount: number;
  lastError?: Record<string, unknown>;
  dependsOn: string[];
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface ExecutionAttemptRecord {
  attemptId: string;
  runId: string;
  nodeId: string;
  attemptNo: number;
  state: ExecutionAttemptState;
  processPid?: number;
  stdoutPath: string;
  stderrPath: string;
  resultPath: string;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number;
  signal?: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutSha256?: string;
  stderrSha256?: string;
  error?: Record<string, unknown>;
}

export interface CreateExecutionRunInput {
  objective: string;
  continuityTaskId?: string;
  originRouteContextId?: string;
  maxConcurrency: number;
  metadata?: Record<string, unknown>;
}

export interface ExecutionStoreStatus {
  healthy: boolean;
  schemaVersion: number;
  integrity: string;
  dbPath: string;
  lastIntegrityCheckAt?: number;
}

export interface ExecutionRecoverableAttempt extends ExecutionAttemptRecord {
  principalId: string;
  projectId?: string;
  runState: ExecutionRunState;
  nodeState: ExecutionNodeState;
}

type RunRow = {
  id: string;
  principal_id: string;
  project_id: string | null;
  continuity_task_id: string | null;
  origin_route_context_id: string | null;
  state: ExecutionRunState;
  objective: string;
  max_concurrency: number;
  last_event_sequence: number;
  metadata_json: string;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  updated_at: number;
};

type NodeRow = {
  run_id: string;
  node_id: string;
  purpose: string;
  command_text: string;
  cwd: string;
  state: ExecutionNodeState;
  timeout_ms: number;
  continue_on_failure: number;
  attempt_count: number;
  last_error_json: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
};

type AttemptRow = {
  id: string;
  run_id: string;
  node_id: string;
  attempt_no: number;
  state: ExecutionAttemptState;
  process_pid: number | null;
  stdout_path: string;
  stderr_path: string;
  result_path: string;
  started_at: number;
  finished_at: number | null;
  exit_code: number | null;
  signal: string | null;
  stdout_bytes: number;
  stderr_bytes: number;
  stdout_sha256: string | null;
  stderr_sha256: string | null;
  error_json: string | null;
};

function fail(code: string, message: string): never {
  throw new ExecutionStoreError(code, message);
}

function scopeProject(scope: ExecutionScope): string {
  return scope.projectId ?? '';
}

function assertScope(scope: ExecutionScope): void {
  if (!scope?.principalId?.trim()) fail('EXECUTION_SCOPE_REQUIRED', 'principalId is required');
}

function boundedText(value: unknown, field: string, max = 20_000): string {
  if (typeof value !== 'string') fail(`EXECUTION_${field.toUpperCase()}_REQUIRED`, `${field} is required`);
  const normalized = value.normalize('NFKC').trim();
  if (!normalized) fail(`EXECUTION_${field.toUpperCase()}_REQUIRED`, `${field} is required`);
  if (normalized.length > max) fail('EXECUTION_TEXT_TOO_LONG', `${field} exceeds ${max} characters`);
  return normalized;
}

function optionalText(value: unknown, field: string, max = 5_000): string | undefined {
  if (value === undefined || value === null) return undefined;
  return boundedText(value, field, max);
}

export function stableExecutionJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableExecutionJson(item)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableExecutionJson(item)}`)
    .join(',')}}`;
}

function parseObject(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function parseMetadata(value: string): Record<string, unknown> {
  return parseObject(value) ?? {};
}

function mapRun(row: RunRow): ExecutionRunRecord {
  return {
    runId: row.id,
    principalId: row.principal_id,
    projectId: row.project_id ?? undefined,
    continuityTaskId: row.continuity_task_id ?? undefined,
    originRouteContextId: row.origin_route_context_id ?? undefined,
    state: row.state,
    objective: row.objective,
    maxConcurrency: Number(row.max_concurrency),
    lastEventSequence: Number(row.last_event_sequence),
    metadata: parseMetadata(row.metadata_json),
    createdAt: Number(row.created_at),
    startedAt: row.started_at == null ? undefined : Number(row.started_at),
    finishedAt: row.finished_at == null ? undefined : Number(row.finished_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapNode(row: NodeRow, dependsOn: string[]): ExecutionNodeRecord {
  return {
    runId: row.run_id,
    nodeId: row.node_id,
    purpose: row.purpose,
    command: row.command_text,
    cwd: row.cwd,
    state: row.state,
    timeoutMs: Number(row.timeout_ms),
    continueOnFailure: Number(row.continue_on_failure) === 1,
    attemptCount: Number(row.attempt_count),
    lastError: parseObject(row.last_error_json),
    dependsOn,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    startedAt: row.started_at == null ? undefined : Number(row.started_at),
    finishedAt: row.finished_at == null ? undefined : Number(row.finished_at),
  };
}

function mapAttempt(row: AttemptRow): ExecutionAttemptRecord {
  return {
    attemptId: row.id,
    runId: row.run_id,
    nodeId: row.node_id,
    attemptNo: Number(row.attempt_no),
    state: row.state,
    processPid: row.process_pid == null ? undefined : Number(row.process_pid),
    stdoutPath: row.stdout_path,
    stderrPath: row.stderr_path,
    resultPath: row.result_path,
    startedAt: Number(row.started_at),
    finishedAt: row.finished_at == null ? undefined : Number(row.finished_at),
    exitCode: row.exit_code == null ? undefined : Number(row.exit_code),
    signal: row.signal ?? undefined,
    stdoutBytes: Number(row.stdout_bytes),
    stderrBytes: Number(row.stderr_bytes),
    stdoutSha256: row.stdout_sha256 ?? undefined,
    stderrSha256: row.stderr_sha256 ?? undefined,
    error: parseObject(row.error_json),
  };
}

const RUN_TERMINAL = new Set<ExecutionRunState>(['completed', 'failed', 'blocked', 'interrupted', 'cancelled']);

export class ExecutionStore {
  private opened = false;
  private closed = false;
  private dbPath = '';
  private lastIntegrity = 'unknown';
  private lastIntegrityCheckAt: number | undefined;

  constructor(readonly client: ExecutionWorkerClient = new ExecutionWorkerClient()) {}

  async open(options: { dbPath: string; busyTimeoutMs?: number }): Promise<ExecutionStoreOpenResult> {
    if (this.closed) fail('EXECUTION_STORE_CLOSED', 'Execution store is closed');
    if (this.opened) {
      const integrity = await this.client.integrity();
      this.lastIntegrity = integrity.result;
      this.lastIntegrityCheckAt = Date.now();
      return {
        schemaVersion: EXECUTION_SCHEMA_VERSION,
        quickCheck: 'ok',
        integrity: integrity.result,
        integrityCheckedAt: this.lastIntegrityCheckAt,
      };
    }
    if (!options?.dbPath?.trim()) fail('EXECUTION_DB_PATH_REQUIRED', 'Execution database path is required');
    const opened = await this.client.open(options);
    const versionRows = await this.client.query<{ user_version: number }>('PRAGMA user_version');
    const priorVersion = Number(versionRows[0]?.user_version ?? 0);
    if (!Number.isInteger(priorVersion) || priorVersion < 0) fail('EXECUTION_SCHEMA_VERSION_INVALID', 'Execution user_version is invalid');
    if (priorVersion > EXECUTION_SCHEMA_VERSION) {
      fail('EXECUTION_SCHEMA_NEWER_THAN_RUNTIME', `Execution schema ${priorVersion} is newer than runtime ${EXECUTION_SCHEMA_VERSION}`);
    }
    await this.client.transaction([
      { kind: 'exec', sql: EXECUTION_SCHEMA_SQL },
      {
        kind: 'run',
        sql: 'INSERT OR IGNORE INTO execution_schema_migrations(version, name, applied_at) VALUES (?, ?, ?)',
        params: [EXECUTION_SCHEMA_VERSION, INITIAL_EXECUTION_MIGRATION, Date.now()],
      },
      { kind: 'exec', sql: `PRAGMA user_version = ${EXECUTION_SCHEMA_VERSION}` },
    ]);
    const integrity = await this.client.integrity();
    this.dbPath = options.dbPath;
    this.lastIntegrity = integrity.result;
    this.lastIntegrityCheckAt = Date.now();
    if (!integrity.ok) fail('EXECUTION_INTEGRITY_FAILED', `Execution SQLite integrity failed: ${integrity.result}`);
    this.opened = true;
    return {
      schemaVersion: EXECUTION_SCHEMA_VERSION,
      quickCheck: opened.quickCheck,
      integrity: integrity.result,
      integrityCheckedAt: this.lastIntegrityCheckAt,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.opened) await this.client.checkpoint();
    } finally {
      await this.client.close();
    }
  }

  async status(): Promise<ExecutionStoreStatus> {
    this.assertReady();
    try {
      const integrity = await this.client.integrity();
      this.lastIntegrity = integrity.result;
      this.lastIntegrityCheckAt = Date.now();
      return {
        healthy: integrity.ok,
        schemaVersion: EXECUTION_SCHEMA_VERSION,
        integrity: integrity.result,
        dbPath: this.dbPath,
        lastIntegrityCheckAt: this.lastIntegrityCheckAt,
      };
    } catch (error) {
      this.lastIntegrityCheckAt = Date.now();
      return {
        healthy: false,
        schemaVersion: EXECUTION_SCHEMA_VERSION,
        integrity: `degraded:${error instanceof Error ? error.message : String(error)}`,
        dbPath: this.dbPath,
        lastIntegrityCheckAt: this.lastIntegrityCheckAt,
      };
    }
  }

  async createRun(scope: ExecutionScope, input: CreateExecutionRunInput): Promise<ExecutionRunRecord> {
    this.assertReady();
    assertScope(scope);
    const objective = boundedText(input?.objective, 'objective');
    if (!Number.isInteger(input?.maxConcurrency) || input.maxConcurrency < 1 || input.maxConcurrency > 128) {
      fail('EXECUTION_CONCURRENCY_INVALID', 'maxConcurrency must be an integer between 1 and 128');
    }
    const continuityTaskId = optionalText(input.continuityTaskId, 'continuityTaskId');
    const originRouteContextId = optionalText(input.originRouteContextId, 'originRouteContextId');
    const metadataJson = stableExecutionJson(input.metadata ?? {});
    if (metadataJson.length > 20_000) fail('EXECUTION_METADATA_TOO_LARGE', 'metadata exceeds 20000 characters');
    const runId = randomUUID();
    const now = Date.now();
    await this.client.transaction([{
      kind: 'run',
      sql: `INSERT INTO execution_runs(
        id, principal_id, project_id, continuity_task_id, origin_route_context_id,
        state, objective, max_concurrency, last_event_sequence, metadata_json,
        created_at, started_at, finished_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'planned', ?, ?, 0, ?, ?, NULL, NULL, ?)`,
      params: [
        runId,
        scope.principalId,
        scope.projectId ?? null,
        continuityTaskId ?? null,
        originRouteContextId ?? null,
        objective,
        input.maxConcurrency,
        metadataJson,
        now,
        now,
      ],
    }]);
    return (await this.getRun(scope, runId))!;
  }

  async persistGraph(scope: ExecutionScope, runId: string, nodes: ValidatedExecutionNode[]): Promise<void> {
    this.assertReady();
    const run = await this.requireRun(scope, runId);
    if (run.state !== 'planned') fail('EXECUTION_RUN_NOT_PLANNED', 'Graph can only be persisted while the run is planned');
    const now = Date.now();
    const operations: ExecutionWorkerSqlOperation[] = [];
    for (const node of nodes) {
      operations.push({
        kind: 'run',
        sql: `INSERT INTO execution_nodes(
          run_id,node_id,purpose,command_text,cwd,state,timeout_ms,continue_on_failure,
          attempt_count,last_error_json,created_at,updated_at,started_at,finished_at
        ) VALUES (?,?,?,?,?,'queued',?,?,0,NULL,?,?,NULL,NULL)`,
        params: [runId, node.id, node.purpose, node.command, node.cwd, node.timeoutMs, node.continueOnFailure ? 1 : 0, now, now],
      });
    }
    for (const node of nodes) {
      for (const dependencyId of node.dependsOn) {
        operations.push({
          kind: 'run',
          sql: `INSERT INTO execution_dependencies(run_id,node_id,depends_on_node_id,dependency_type,created_at)
                VALUES (?,?,?,'hard',?)`,
          params: [runId, node.id, dependencyId, now],
        });
      }
    }
    await this.client.transaction(operations);
  }

  async appendGraphNodes(scope: ExecutionScope, runId: string, nodes: ValidatedExecutionNode[]): Promise<void> {
    this.assertReady();
    const run = await this.requireRun(scope, runId);
    if (run.state !== 'planned' && run.state !== 'running') {
      fail('EXECUTION_RUN_NOT_EXTENSIBLE', `Nodes can only be added while run is planned or running, not ${run.state}`);
    }
    if (nodes.length < 1) fail('EXECUTION_NODES_REQUIRED', 'At least one execution node is required');
    const now = Date.now();
    const operations: ExecutionWorkerSqlOperation[] = [];
    for (const node of nodes) {
      operations.push({
        kind: 'run',
        sql: `INSERT INTO execution_nodes(
          run_id,node_id,purpose,command_text,cwd,state,timeout_ms,continue_on_failure,
          attempt_count,last_error_json,created_at,updated_at,started_at,finished_at
        ) VALUES (?,?,?,?,?,'queued',?,?,0,NULL,?,?,NULL,NULL)`,
        params: [runId, node.id, node.purpose, node.command, node.cwd, node.timeoutMs, node.continueOnFailure ? 1 : 0, now, now],
      });
    }
    for (const node of nodes) {
      for (const dependencyId of node.dependsOn) {
        operations.push({
          kind: 'run',
          sql: `INSERT INTO execution_dependencies(run_id,node_id,depends_on_node_id,dependency_type,created_at)
                VALUES (?,?,?,'hard',?)`,
          params: [runId, node.id, dependencyId, now],
        });
      }
    }
    await this.client.transaction(operations);
  }

  async getRun(scope: ExecutionScope, runId: string): Promise<ExecutionRunRecord | null> {
    this.assertReady();
    assertScope(scope);
    const normalizedRunId = boundedText(runId, 'runId', 5_000);
    const rows = await this.client.query<RunRow>(
      `SELECT id, principal_id, project_id, continuity_task_id, origin_route_context_id, state,
              objective, max_concurrency, last_event_sequence, metadata_json, created_at,
              started_at, finished_at, updated_at
         FROM execution_runs
        WHERE id = ? AND principal_id = ? AND IFNULL(project_id, '') = ?
        LIMIT 1`,
      [normalizedRunId, scope.principalId, scopeProject(scope)],
    );
    return rows[0] ? mapRun(rows[0]) : null;
  }

  async listRuns(scope: ExecutionScope, limit = 100): Promise<ExecutionRunRecord[]> {
    this.assertReady();
    assertScope(scope);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      fail('EXECUTION_LIMIT_INVALID', 'limit must be an integer between 1 and 1000');
    }
    const rows = await this.client.query<RunRow>(
      `SELECT id, principal_id, project_id, continuity_task_id, origin_route_context_id, state,
              objective, max_concurrency, last_event_sequence, metadata_json, created_at,
              started_at, finished_at, updated_at
         FROM execution_runs
        WHERE principal_id = ? AND IFNULL(project_id, '') = ?
        ORDER BY updated_at DESC, id COLLATE BINARY ASC
        LIMIT ?`,
      [scope.principalId, scopeProject(scope), limit],
    );
    return rows.map(mapRun);
  }

  async getNodes(scope: ExecutionScope, runId: string): Promise<ExecutionNodeRecord[]> {
    this.assertReady();
    await this.requireRun(scope, runId);
    const rows = await this.client.query<NodeRow>(
      `SELECT run_id,node_id,purpose,command_text,cwd,state,timeout_ms,continue_on_failure,
              attempt_count,last_error_json,created_at,updated_at,started_at,finished_at
         FROM execution_nodes WHERE run_id = ? ORDER BY node_id COLLATE BINARY`,
      [runId],
    );
    const deps = await this.client.query<{ node_id: string; depends_on_node_id: string }>(
      `SELECT node_id,depends_on_node_id FROM execution_dependencies
        WHERE run_id = ? ORDER BY node_id COLLATE BINARY, depends_on_node_id COLLATE BINARY`,
      [runId],
    );
    const byNode = new Map<string, string[]>();
    for (const dep of deps) {
      const list = byNode.get(dep.node_id) ?? [];
      list.push(dep.depends_on_node_id);
      byNode.set(dep.node_id, list);
    }
    return rows.map((row) => mapNode(row, byNode.get(row.node_id) ?? []));
  }

  async getNode(scope: ExecutionScope, runId: string, nodeId: string): Promise<ExecutionNodeRecord | null> {
    const nodes = await this.getNodes(scope, runId);
    return nodes.find((node) => node.nodeId === nodeId) ?? null;
  }

  async setRunState(scope: ExecutionScope, runId: string, state: ExecutionRunState): Promise<void> {
    const run = await this.requireRun(scope, runId);
    if (run.state === state) return;
    const now = Date.now();
    const terminal = RUN_TERMINAL.has(state);
    await this.client.transaction([{
      kind: 'run',
      sql: `UPDATE execution_runs
               SET state = ?,
                   started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
                   finished_at = ?, updated_at = ?
             WHERE id = ? AND principal_id = ? AND IFNULL(project_id, '') = ?`,
      params: [state, state, now, terminal ? now : null, now, runId, scope.principalId, scopeProject(scope)],
    }]);
  }

  async setNodeState(
    scope: ExecutionScope,
    runId: string,
    nodeId: string,
    state: ExecutionNodeState,
    lastError?: Record<string, unknown>,
  ): Promise<void> {
    await this.requireRun(scope, runId);
    const now = Date.now();
    const terminal = ['succeeded', 'failed', 'blocked', 'interrupted', 'cancelled'].includes(state);
    await this.client.transaction([{
      kind: 'run',
      sql: `UPDATE execution_nodes
               SET state = ?, last_error_json = ?, updated_at = ?,
                   started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
                   finished_at = ?
             WHERE run_id = ? AND node_id = ?`,
      params: [state, lastError ? stableExecutionJson(lastError) : null, now, state, now, terminal ? now : null, runId, nodeId],
    }]);
  }

  async createAttempt(
    scope: ExecutionScope,
    runId: string,
    nodeId: string,
    attemptId: string,
    attemptNo: number,
    paths: ExecutionAttemptPaths,
  ): Promise<void> {
    await this.requireRun(scope, runId);
    const node = await this.getNode(scope, runId, nodeId);
    if (!node) fail('EXECUTION_NODE_NOT_FOUND', 'Execution node was not found');
    if (attemptNo !== node.attemptCount + 1) fail('EXECUTION_ATTEMPT_SEQUENCE_INVALID', 'attemptNo must increment exactly by one');
    const now = Date.now();
    await this.client.transaction([
      {
        kind: 'run',
        sql: `INSERT INTO execution_attempts(
          id,run_id,node_id,attempt_no,state,process_pid,stdout_path,stderr_path,result_path,
          started_at,finished_at,exit_code,signal,stdout_bytes,stderr_bytes,stdout_sha256,stderr_sha256,error_json
        ) VALUES (?,?,?,?,'running',NULL,?,?,?, ?,NULL,NULL,NULL,0,0,NULL,NULL,NULL)`,
        params: [attemptId, runId, nodeId, attemptNo, paths.stdoutPath, paths.stderrPath, paths.resultPath, now],
      },
      {
        kind: 'run',
        sql: `UPDATE execution_nodes
                 SET state='running', attempt_count=?, updated_at=?, started_at=COALESCE(started_at,?), finished_at=NULL, last_error_json=NULL
               WHERE run_id=? AND node_id=?`,
        params: [attemptNo, now, now, runId, nodeId],
      },
    ]);
  }

  async setAttemptPid(scope: ExecutionScope, runId: string, attemptId: string, pid: number | null): Promise<void> {
    await this.requireRun(scope, runId);
    await this.client.transaction([{
      kind: 'run',
      sql: 'UPDATE execution_attempts SET process_pid = ? WHERE id = ? AND run_id = ?',
      params: [pid, attemptId, runId],
    }]);
  }

  async completeAttempt(scope: ExecutionScope, marker: ExecutionResultMarker): Promise<void> {
    await this.requireRun(scope, marker.runId);
    const nodeState: ExecutionNodeState = marker.state === 'succeeded'
      ? 'succeeded'
      : marker.state === 'failed'
        ? 'failed'
        : marker.state;
    const error = marker.error
      ? { message: marker.error }
      : marker.state === 'failed'
        ? { exitCode: marker.exitCode, signal: marker.signal }
        : undefined;
    const now = marker.finishedAt;
    await this.client.transaction([
      {
        kind: 'run',
        sql: `UPDATE execution_attempts
                 SET state=?, finished_at=?, exit_code=?, signal=?, stdout_bytes=?, stderr_bytes=?,
                     stdout_sha256=?, stderr_sha256=?, error_json=?
               WHERE id=? AND run_id=? AND node_id=? AND attempt_no=?`,
        params: [
          marker.state, marker.finishedAt, marker.exitCode, marker.signal,
          marker.stdoutBytes, marker.stderrBytes, marker.stdoutSha256, marker.stderrSha256,
          error ? stableExecutionJson(error) : null,
          marker.attemptId, marker.runId, marker.nodeId, marker.attemptNo,
        ],
      },
      {
        kind: 'run',
        sql: `UPDATE execution_nodes
                 SET state=?, last_error_json=?, finished_at=?, updated_at=?
               WHERE run_id=? AND node_id=?`,
        params: [nodeState, error ? stableExecutionJson(error) : null, now, now, marker.runId, marker.nodeId],
      },
    ]);
  }

  async failAttemptStart(
    scope: ExecutionScope,
    runId: string,
    nodeId: string,
    attemptId: string,
    error: Error,
  ): Promise<void> {
    await this.requireRun(scope, runId);
    const now = Date.now();
    const payload = { message: error.message, name: error.name };
    await this.client.transaction([
      {
        kind: 'run',
        sql: `UPDATE execution_attempts SET state='failed', finished_at=?, error_json=? WHERE id=? AND run_id=?`,
        params: [now, stableExecutionJson(payload), attemptId, runId],
      },
      {
        kind: 'run',
        sql: `UPDATE execution_nodes SET state='failed', finished_at=?, updated_at=?, last_error_json=? WHERE run_id=? AND node_id=?`,
        params: [now, now, stableExecutionJson(payload), runId, nodeId],
      },
    ]);
  }

  async listAttempts(scope: ExecutionScope, runId: string, nodeId?: string): Promise<ExecutionAttemptRecord[]> {
    await this.requireRun(scope, runId);
    const rows = await this.client.query<AttemptRow>(
      `SELECT id,run_id,node_id,attempt_no,state,process_pid,stdout_path,stderr_path,result_path,
              started_at,finished_at,exit_code,signal,stdout_bytes,stderr_bytes,stdout_sha256,stderr_sha256,error_json
         FROM execution_attempts
        WHERE run_id = ? ${nodeId ? 'AND node_id = ?' : ''}
        ORDER BY node_id COLLATE BINARY, attempt_no`,
      nodeId ? [runId, nodeId] : [runId],
    );
    return rows.map(mapAttempt);
  }

  async listRecoverableAttempts(): Promise<ExecutionRecoverableAttempt[]> {
    this.assertReady();
    const rows = await this.client.query<Record<string, unknown>>(
      `SELECT attempt.id, attempt.run_id, attempt.node_id, attempt.attempt_no, attempt.state,
              attempt.process_pid, attempt.stdout_path, attempt.stderr_path, attempt.result_path,
              attempt.started_at, attempt.finished_at, attempt.exit_code, attempt.signal,
              attempt.stdout_bytes, attempt.stderr_bytes, attempt.stdout_sha256, attempt.stderr_sha256,
              attempt.error_json, run.principal_id, run.project_id, run.state AS run_state, node.state AS node_state
         FROM execution_attempts AS attempt
         JOIN execution_runs AS run ON run.id = attempt.run_id
         JOIN execution_nodes AS node ON node.run_id = attempt.run_id AND node.node_id = attempt.node_id
        WHERE attempt.state = 'running'
        ORDER BY run.id COLLATE BINARY, node.node_id COLLATE BINARY, attempt.attempt_no`,
    );
    return rows.map((row) => ({
      attemptId: String(row.id), runId: String(row.run_id), nodeId: String(row.node_id),
      attemptNo: Number(row.attempt_no), state: String(row.state) as ExecutionAttemptState,
      processPid: row.process_pid == null ? undefined : Number(row.process_pid),
      stdoutPath: String(row.stdout_path), stderrPath: String(row.stderr_path), resultPath: String(row.result_path),
      startedAt: Number(row.started_at), finishedAt: row.finished_at == null ? undefined : Number(row.finished_at),
      exitCode: row.exit_code == null ? undefined : Number(row.exit_code), signal: row.signal == null ? undefined : String(row.signal),
      stdoutBytes: Number(row.stdout_bytes), stderrBytes: Number(row.stderr_bytes),
      stdoutSha256: row.stdout_sha256 == null ? undefined : String(row.stdout_sha256),
      stderrSha256: row.stderr_sha256 == null ? undefined : String(row.stderr_sha256),
      error: parseObject(row.error_json == null ? null : String(row.error_json)),
      principalId: String(row.principal_id), projectId: row.project_id == null ? undefined : String(row.project_id),
      runState: String(row.run_state) as ExecutionRunState, nodeState: String(row.node_state) as ExecutionNodeState,
    }));
  }

  async markAttemptInterrupted(scope: ExecutionScope, runId: string, nodeId: string, attemptId: string, reason: string): Promise<void> {
    await this.requireRun(scope, runId);
    const now = Date.now();
    const errorJson = stableExecutionJson({ reason: reason.slice(0, 2_000), recovery: true });
    await this.client.transaction([
      { kind: 'run', sql: `UPDATE execution_attempts SET state='interrupted', finished_at=?, error_json=? WHERE id=? AND run_id=? AND node_id=? AND state='running'`, params: [now, errorJson, attemptId, runId, nodeId] },
      { kind: 'run', sql: `UPDATE execution_nodes SET state='interrupted', finished_at=?, updated_at=?, last_error_json=? WHERE run_id=? AND node_id=? AND state='running'`, params: [now, now, errorJson, runId, nodeId] },
    ]);
  }

  async appendEvent(
    scope: ExecutionScope,
    runId: string,
    eventType: ExecutionEventType,
    options: { nodeId?: string; attemptId?: string; payload?: Record<string, unknown> } = {},
  ): Promise<ExecutionEventRecord> {
    await this.requireRun(scope, runId);
    const createdAt = Date.now();
    const payloadJson = stableExecutionJson(options.payload ?? {});
    if (payloadJson.length > 20_000) fail('EXECUTION_EVENT_PAYLOAD_TOO_LARGE', 'Execution event payload exceeds 20000 characters');
    const results = await this.client.transaction([
      {
        kind: 'query',
        mode: 'get',
        sql: `UPDATE execution_runs
                 SET last_event_sequence = last_event_sequence + 1, updated_at = ?
               WHERE id = ? AND principal_id = ? AND IFNULL(project_id, '') = ?
               RETURNING last_event_sequence`,
        params: [createdAt, runId, scope.principalId, scopeProject(scope)],
      },
      {
        kind: 'run',
        sql: `INSERT INTO execution_events(run_id, sequence, event_type, node_id, attempt_id, payload_json, created_at)
              SELECT id, last_event_sequence, ?, ?, ?, ?, ?
                FROM execution_runs
               WHERE id = ? AND principal_id = ? AND IFNULL(project_id, '') = ?`,
        params: [
          eventType, options.nodeId ?? null, options.attemptId ?? null, payloadJson, createdAt,
          runId, scope.principalId, scopeProject(scope),
        ],
      },
      {
        kind: 'query',
        mode: 'get',
        sql: `SELECT event.run_id, event.sequence, event.event_type, event.node_id, event.attempt_id,
                     event.payload_json, event.created_at
                FROM execution_events AS event
                JOIN execution_runs AS run ON run.id = event.run_id
               WHERE event.run_id = ? AND event.sequence = run.last_event_sequence
                 AND run.principal_id = ? AND IFNULL(run.project_id, '') = ?`,
        params: [runId, scope.principalId, scopeProject(scope)],
      },
    ]);
    const row = results[2] as Record<string, unknown> | undefined;
    if (!row) fail('EXECUTION_EVENT_PERSIST_FAILED', 'Execution event transaction did not return a persisted event');
    return {
      runId: String(row.run_id),
      sequence: Number(row.sequence),
      eventType: String(row.event_type) as ExecutionEventType,
      nodeId: row.node_id == null ? undefined : String(row.node_id),
      attemptId: row.attempt_id == null ? undefined : String(row.attempt_id),
      payload: parseObject(String(row.payload_json)) ?? {},
      createdAt: Number(row.created_at),
    };
  }

  async getEvents(
    scope: ExecutionScope,
    runId: string,
    afterSequence = 0,
    filters?: ExecutionEventFilter,
    limit = 1000,
  ): Promise<ExecutionEventRecord[]> {
    await this.requireRun(scope, runId);
    if (!Number.isInteger(afterSequence) || afterSequence < 0) {
      fail('EXECUTION_EVENT_SEQUENCE_INVALID', 'afterSequence must be a non-negative integer');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) {
      fail('EXECUTION_EVENT_LIMIT_INVALID', 'event limit must be between 1 and 5000');
    }
    const eventTypes = [...new Set(filters?.eventTypes ?? [])];
    const nodeIds = [...new Set(filters?.nodeIds ?? [])];
    const params: Array<string | number | null> = [runId, scope.principalId, scopeProject(scope), afterSequence];
    let where = `event.run_id = ? AND run.principal_id = ? AND IFNULL(run.project_id, '') = ? AND event.sequence > ?`;
    if (eventTypes.length > 0) {
      where += ` AND event.event_type IN (${eventTypes.map(() => '?').join(',')})`;
      params.push(...eventTypes);
    }
    if (nodeIds.length > 0) {
      where += ` AND event.node_id IN (${nodeIds.map(() => '?').join(',')})`;
      params.push(...nodeIds);
    }
    params.push(limit);
    const rows = await this.client.query<Record<string, unknown>>(
      `SELECT event.run_id, event.sequence, event.event_type, event.node_id, event.attempt_id,
              event.payload_json, event.created_at
         FROM execution_events AS event
         JOIN execution_runs AS run ON run.id = event.run_id
        WHERE ${where}
        ORDER BY event.sequence ASC
        LIMIT ?`,
      params,
    );
    return rows.map((row) => ({
      runId: String(row.run_id),
      sequence: Number(row.sequence),
      eventType: String(row.event_type) as ExecutionEventType,
      nodeId: row.node_id == null ? undefined : String(row.node_id),
      attemptId: row.attempt_id == null ? undefined : String(row.attempt_id),
      payload: parseObject(String(row.payload_json)) ?? {},
      createdAt: Number(row.created_at),
    }));
  }

  async enqueueMemorySync(
    scope: ExecutionScope,
    runId: string,
    eventSequence: number | undefined,
    syncKey: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.requireRun(scope, runId);
    const normalizedKey = boundedText(syncKey, 'syncKey', 5_000);
    const payloadJson = stableExecutionJson(payload);
    if (payloadJson.length > 50_000) fail('EXECUTION_SYNC_PAYLOAD_TOO_LARGE', 'Execution memory sync payload exceeds 50000 characters');
    const now = Date.now();
    await this.client.transaction([{
      kind: 'run',
      sql: `INSERT INTO execution_memory_sync_queue(
              id, run_id, event_sequence, sync_key, payload_json, state, attempts, last_error, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'queued', 0, NULL, ?, ?)
            ON CONFLICT(sync_key) DO NOTHING`,
      params: [randomUUID(), runId, eventSequence ?? null, normalizedKey, payloadJson, now, now],
    }]);
  }

  async listMemorySyncQueue(
    scope: ExecutionScope,
    limit = 100,
  ): Promise<Array<{
    queueId: string;
    runId: string;
    eventSequence?: number;
    syncKey: string;
    payload: Record<string, unknown>;
    state: 'queued' | 'syncing' | 'failed';
    attempts: number;
    lastError?: string;
    createdAt: number;
    updatedAt: number;
  }>> {
    assertScope(scope);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      fail('EXECUTION_SYNC_LIMIT_INVALID', 'sync queue limit must be between 1 and 1000');
    }
    const rows = await this.client.query<Record<string, unknown>>(
      `SELECT queue.id, queue.run_id, queue.event_sequence, queue.sync_key, queue.payload_json,
              queue.state, queue.attempts, queue.last_error, queue.created_at, queue.updated_at
         FROM execution_memory_sync_queue AS queue
         JOIN execution_runs AS run ON run.id = queue.run_id
        WHERE run.principal_id = ? AND IFNULL(run.project_id, '') = ?
          AND queue.state IN ('queued','syncing','failed')
        ORDER BY queue.created_at ASC, queue.id COLLATE BINARY ASC
        LIMIT ?`,
      [scope.principalId, scopeProject(scope), limit],
    );
    return rows.map((row) => ({
      queueId: String(row.id),
      runId: String(row.run_id),
      eventSequence: row.event_sequence == null ? undefined : Number(row.event_sequence),
      syncKey: String(row.sync_key),
      payload: parseObject(String(row.payload_json)) ?? {},
      state: String(row.state) as 'queued' | 'syncing' | 'failed',
      attempts: Number(row.attempts),
      lastError: row.last_error == null ? undefined : String(row.last_error),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }));
  }

  async countMemorySyncQueue(scope: ExecutionScope): Promise<number> {
    assertScope(scope);
    const rows = await this.client.query<{ count: number }>(
      `SELECT count(*) AS count
         FROM execution_memory_sync_queue AS queue
         JOIN execution_runs AS run ON run.id = queue.run_id
        WHERE run.principal_id = ? AND IFNULL(run.project_id, '') = ?
          AND queue.state IN ('queued','syncing','failed')`,
      [scope.principalId, scopeProject(scope)],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async markMemorySyncState(
    scope: ExecutionScope,
    queueId: string,
    state: 'syncing' | 'synced' | 'failed',
    error?: string,
  ): Promise<void> {
    assertScope(scope);
    const now = Date.now();
    await this.client.transaction([{
      kind: 'run',
      sql: `UPDATE execution_memory_sync_queue
               SET state = ?, attempts = attempts + 1, last_error = ?, updated_at = ?
             WHERE id = ? AND run_id IN (
               SELECT id FROM execution_runs WHERE principal_id = ? AND IFNULL(project_id, '') = ?
             )`,
      params: [state, error ? error.slice(0, 2_000) : null, now, queueId, scope.principalId, scopeProject(scope)],
    }]);
  }

  async resetNodeForRetry(scope: ExecutionScope, runId: string, nodeId: string): Promise<void> {
    const run = await this.requireRun(scope, runId);
    const node = await this.getNode(scope, runId, nodeId);
    if (!node) fail('EXECUTION_NODE_NOT_FOUND', 'Execution node was not found');
    if (!['failed', 'interrupted', 'cancelled'].includes(node.state)) {
      fail('EXECUTION_RETRY_NOT_ALLOWED', `Node ${nodeId} is not retryable from state ${node.state}`);
    }
    const now = Date.now();
    await this.client.transaction([
      {
        kind: 'run',
        sql: `UPDATE execution_nodes SET state='queued', last_error_json=NULL, finished_at=NULL, updated_at=?
               WHERE run_id=? AND node_id=?`,
        params: [now, runId, nodeId],
      },
      {
        kind: 'run',
        sql: `UPDATE execution_nodes SET state='queued', last_error_json=NULL, finished_at=NULL, updated_at=?
               WHERE run_id=? AND state='blocked'`,
        params: [now, runId],
      },
      {
        kind: 'run',
        sql: `UPDATE execution_runs SET state='running', finished_at=NULL, updated_at=?
               WHERE id=? AND principal_id=? AND IFNULL(project_id,'')=?`,
        params: [now, runId, scope.principalId, scopeProject(scope)],
      },
    ]);
    void run;
  }

  private async requireRun(scope: ExecutionScope, runId: string): Promise<ExecutionRunRecord> {
    assertScope(scope);
    const run = await this.getRun(scope, runId);
    if (!run) fail('EXECUTION_RUN_NOT_FOUND', 'Execution run was not found in authenticated scope');
    return run;
  }

  private assertReady(): void {
    if (!this.opened || this.closed) fail('EXECUTION_STORE_NOT_OPEN', 'Execution store is not open');
  }
}
