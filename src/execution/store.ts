import { randomUUID } from 'node:crypto';
import { EXECUTION_SCHEMA_SQL, EXECUTION_SCHEMA_VERSION, INITIAL_EXECUTION_MIGRATION } from './schema.js';
import type { ExecutionRunState, ExecutionScope } from './types.js';
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

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`;
}

function parseMetadata(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
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
    const metadataJson = stableJson(input.metadata ?? {});
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

  private assertReady(): void {
    if (!this.opened || this.closed) fail('EXECUTION_STORE_NOT_OPEN', 'Execution store is not open');
  }
}
