import { createHash, randomUUID } from 'node:crypto';
import type { MemoryWorkerSqlOperation } from '../memory/db-worker.js';
import { normalizeMemoryText } from '../memory/normalizer.js';
import { redactMemoryText } from '../memory/redaction.js';
import type { MemoryScope } from '../memory/types.js';
import type { MemoryWorkerClient } from '../memory/worker-client.js';
import {
  isTerminalContinuityTaskStatus,
  normalizeContinuityCapture,
  normalizeContinuityCheckpointInput,
  type ContinuityCapture,
  type ContinuityCheckpointInput,
  type ContinuityTaskStatus,
  type ContinuityTurnState,
  type FrontierStatus,
} from './types.js';

export class ContinuityStoreError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ContinuityStoreError';
  }
}

export interface ContinuityTaskRecord {
  taskId: string;
  principalId: string;
  projectId?: string;
  parentTaskId?: string;
  title: string;
  objective?: string;
  acceptanceCriteria: string[];
  constraints: string[];
  status: ContinuityTaskStatus;
  priority: number;
  blockers: Array<Record<string, unknown>>;
  lastCheckpointId?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface ContinuityFrontierRecord {
  frontierId: string;
  sourceTaskId: string;
  title: string;
  rationale: string;
  status: FrontierStatus;
  dependencyTaskIds: string[];
  priority: number;
  createdAt: number;
  updatedAt: number;
}

export interface ContinuityBeginTurnResult {
  turnId: string;
  taskId: string;
}

export interface ContinuityCheckpointResult {
  checkpointId: string;
  taskStatus: ContinuityTaskStatus;
  snapshotHash: string;
}

type TaskRow = {
  id: string;
  principal_id: string;
  project_id: string | null;
  parent_task_id: string | null;
  title: string;
  objective: string | null;
  acceptance_json: string;
  constraints_json: string;
  status: ContinuityTaskStatus;
  priority: number;
  blocker_json: string;
  last_checkpoint_id: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
};

type TurnRow = {
  id: string;
  principal_id: string;
  project_id: string | null;
  route_context_id: string;
  task_id: string;
  state: ContinuityTurnState;
};

const TRANSITIONS: Record<ContinuityTaskStatus, ReadonlySet<ContinuityTaskStatus>> = {
  planned: new Set(['planned', 'ready', 'running', 'cancelled']),
  ready: new Set(['ready', 'running', 'blocked', 'deferred', 'cancelled']),
  running: new Set(['running', 'blocked', 'deferred', 'completed', 'failed', 'cancelled', 'interrupted']),
  blocked: new Set(['blocked', 'ready', 'running', 'deferred', 'failed', 'cancelled', 'interrupted']),
  deferred: new Set(['deferred', 'ready', 'running', 'cancelled', 'interrupted']),
  completed: new Set(['completed']),
  failed: new Set(['failed', 'ready', 'running', 'cancelled']),
  cancelled: new Set(['cancelled']),
  interrupted: new Set(['interrupted', 'ready', 'running', 'cancelled']),
};

function fail(code: string, message: string): never {
  throw new ContinuityStoreError(code, message);
}

function scopeProject(scope: MemoryScope): string {
  return scope.projectId ?? '';
}

function assertScope(scope: MemoryScope): void {
  if (!scope?.principalId?.trim()) fail('CONTINUITY_SCOPE_REQUIRED', 'principalId is required');
}

function text(value: unknown, field: string, max = 20_000): string {
  if (typeof value !== 'string') fail('CONTINUITY_TEXT_REQUIRED', `${field} is required`);
  const normalized = value.normalize('NFKC').trim();
  if (!normalized) fail('CONTINUITY_TEXT_REQUIRED', `${field} is required`);
  if (normalized.length > max) fail('CONTINUITY_TEXT_TOO_LONG', `${field} exceeds ${max} characters`);
  return normalized;
}

function optionalText(value: unknown, max = 20_000): string | undefined {
  if (value === undefined || value === null) return undefined;
  const normalized = text(value, 'value', max);
  return normalized || undefined;
}

function safeString(value: string): string {
  return normalizeMemoryText(redactMemoryText(value).text).canonical;
}

function safeStructured(value: unknown, key = ''): unknown {
  if (/^(?:authorization|api[_-]?key|client[_-]?secret|access[_-]?key|password|passwd|pwd|token|refresh[_-]?token|access[_-]?token)$/i.test(key)) {
    return '[REDACTED:SECRET]';
  }
  if (typeof value === 'string') return safeString(value);
  if (Array.isArray(value)) return value.map((item) => safeStructured(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([entryKey, item]) => [entryKey, safeStructured(item, entryKey)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([entryKey, item]) => `${JSON.stringify(entryKey)}:${stableJson(item)}`)
    .join(',')}}`;
}

function hash(value: unknown): string {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

function jsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mapTask(row: TaskRow): ContinuityTaskRecord {
  return {
    taskId: row.id,
    principalId: row.principal_id,
    projectId: row.project_id ?? undefined,
    parentTaskId: row.parent_task_id ?? undefined,
    title: row.title,
    objective: row.objective ?? undefined,
    acceptanceCriteria: jsonArray(row.acceptance_json).map(String),
    constraints: jsonArray(row.constraints_json).map(String),
    status: row.status,
    priority: Number(row.priority),
    blockers: jsonArray(row.blocker_json).filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item))),
    lastCheckpointId: row.last_checkpoint_id ?? undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    completedAt: row.completed_at == null ? undefined : Number(row.completed_at),
  };
}

function assertTransition(from: ContinuityTaskStatus, to: ContinuityTaskStatus): void {
  if (!TRANSITIONS[from]?.has(to)) {
    fail('CONTINUITY_TRANSITION_INVALID', `Task transition ${from} -> ${to} is not allowed`);
  }
}

function eventOperation(
  scope: MemoryScope,
  eventType: string,
  sourceRef: string,
  eventText: string,
  metadata: Record<string, unknown>,
  createdAt: number,
): MemoryWorkerSqlOperation {
  return {
    kind: 'run',
    sql: `INSERT INTO memory_events(
      id, principal_id, project_id, thread_id, resource_id, event_type, source_type, source_ref,
      raw_text, redacted_text, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'continuity_ledger', ?, NULL, ?, ?, ?)`,
    params: [
      randomUUID(), scope.principalId, scope.projectId ?? null, scope.threadId ?? null, scope.resourceId ?? null,
      eventType, sourceRef, safeString(eventText), stableJson(safeStructured(metadata)), createdAt,
    ],
  };
}

export class ContinuityStore {
  constructor(readonly client: MemoryWorkerClient) {}

  async beginTurn(
    scope: MemoryScope,
    routeContextId: string,
    task: string,
    context: string | undefined,
    capture: ContinuityCapture = {},
    expiresAt?: number,
  ): Promise<ContinuityBeginTurnResult> {
    assertScope(scope);
    const route = text(routeContextId, 'routeContextId', 5_000);
    const normalizedTask = safeString(text(task, 'task'));
    const normalizedContext = context === undefined ? undefined : safeString(text(context, 'context'));
    const normalizedCapture = safeStructured(normalizeContinuityCapture(capture)) as ContinuityCapture;
    if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) {
      fail('CONTINUITY_EXPIRY_INVALID', 'expiresAt must be in the future');
    }

    let taskId: string;
    let currentStatus: ContinuityTaskStatus | undefined;
    let createTask = true;
    if (normalizedCapture.resumeTaskId) {
      const existing = await this.findTask(scope, normalizedCapture.resumeTaskId);
      if (!existing) fail('CONTINUITY_TASK_NOT_FOUND', 'Resume task was not found in authenticated scope');
      if (isTerminalContinuityTaskStatus(existing.status) && existing.status !== 'failed') {
        fail('CONTINUITY_TASK_TERMINAL', 'Completed/cancelled tasks cannot be resumed');
      }
      assertTransition(existing.status, 'running');
      taskId = existing.taskId;
      currentStatus = existing.status;
      createTask = false;
    } else {
      taskId = randomUUID();
      if (normalizedCapture.parentTaskId) {
        const parent = await this.findTask(scope, normalizedCapture.parentTaskId);
        if (!parent) fail('CONTINUITY_PARENT_NOT_FOUND', 'Parent task was not found in authenticated scope');
      }
    }

    const turnId = randomUUID();
    const now = Date.now();
    const title = safeString(normalizedCapture.objective || normalizedTask);
    const inputHash = hash({ task: normalizedTask, context: normalizedContext ?? null, capture: normalizedCapture });
    const operations: MemoryWorkerSqlOperation[] = [];

    if (!createTask) {
      const abandonedTurns = await this.client.query<{ id: string }>(
        `SELECT id FROM continuity_turns
          WHERE principal_id = ? AND IFNULL(project_id, '') = ? AND task_id = ? AND state = 'open'
          ORDER BY created_at ASC, id COLLATE BINARY`,
        [scope.principalId, scopeProject(scope), taskId],
      );
      for (const abandoned of abandonedTurns) {
        operations.push({
          kind: 'run',
          sql: `UPDATE continuity_turns SET state = 'interrupted', closed_at = ?
                WHERE id = ? AND principal_id = ? AND IFNULL(project_id, '') = ? AND state = 'open'`,
          params: [now, abandoned.id, scope.principalId, scopeProject(scope)],
        });
        operations.push(eventOperation(scope, 'continuity.turn_interrupted', abandoned.id, 'continuity turn interrupted by resume', {
          turnId: abandoned.id,
          taskId,
          replacementTurnId: turnId,
          routeContextId: route,
          reason: 'resumed_by_new_turn',
        }, now));
      }
    }

    if (createTask) {
      operations.push({
        kind: 'run',
        sql: `INSERT INTO continuity_tasks(
          id, principal_id, project_id, parent_task_id, title, objective, acceptance_json, constraints_json,
          status, priority, blocker_json, last_checkpoint_id, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', 0, '[]', NULL, ?, ?, NULL)`,
        params: [
          taskId, scope.principalId, scope.projectId ?? null, normalizedCapture.parentTaskId ?? null,
          title, normalizedCapture.objective ?? null,
          stableJson(normalizedCapture.acceptanceCriteria ?? []), stableJson(normalizedCapture.constraints ?? []),
          now, now,
        ],
      });
      operations.push(eventOperation(scope, 'continuity.task_state_changed', taskId, 'continuity task running', {
        taskId, from: null, to: 'running', routeContextId: route,
      }, now));
    } else if (currentStatus !== 'running') {
      operations.push({
        kind: 'run',
        sql: `UPDATE continuity_tasks SET status = 'running', updated_at = ?, completed_at = NULL
              WHERE id = ? AND principal_id = ? AND IFNULL(project_id, '') = ?`,
        params: [now, taskId, scope.principalId, scopeProject(scope)],
      });
      operations.push(eventOperation(scope, 'continuity.task_state_changed', taskId, 'continuity task resumed', {
        taskId, from: currentStatus, to: 'running', routeContextId: route,
      }, now));
    }

    operations.push({
      kind: 'run',
      sql: `INSERT INTO continuity_turns(
        id, principal_id, project_id, route_context_id, task_id, input_text, input_hash, context_text,
        state, created_at, closed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, NULL)`,
      params: [
        turnId, scope.principalId, scope.projectId ?? null, route, taskId,
        normalizedTask, inputHash, normalizedContext ?? null, now,
      ],
    });
    operations.push(eventOperation(scope, 'continuity.turn_opened', turnId, 'continuity turn opened', {
      turnId, taskId, routeContextId: route, inputHash, expiresAt: expiresAt ?? null,
    }, now + 1));

    await this.client.transaction(operations);
    return { turnId, taskId };
  }

  async checkpoint(
    scope: MemoryScope,
    taskId: string,
    turnId: string,
    input: ContinuityCheckpointInput,
  ): Promise<ContinuityCheckpointResult> {
    assertScope(scope);
    const normalizedTaskId = text(taskId, 'taskId', 5_000);
    const normalizedTurnId = text(turnId, 'turnId', 5_000);
    const normalized = safeStructured(normalizeContinuityCheckpointInput(input)) as ContinuityCheckpointInput;
    const task = await this.findTask(scope, normalizedTaskId);
    if (!task) fail('CONTINUITY_TASK_NOT_FOUND', 'Task was not found in authenticated scope');
    const turn = await this.findTurn(scope, normalizedTurnId);
    if (!turn || turn.task_id !== normalizedTaskId) fail('CONTINUITY_TURN_NOT_FOUND', 'Turn was not found for this task in authenticated scope');
    if (turn.state !== 'open') fail('CONTINUITY_TURN_NOT_OPEN', 'Checkpoint requires an open turn');
    if (turn.route_context_id !== normalized.routeContextId) fail('CONTINUITY_ROUTE_MISMATCH', 'Checkpoint route does not match the turn route');
    assertTransition(task.status, normalized.status);

    const checkpointId = randomUUID();
    const now = Date.now();
    const statePayload = {
      taskId: normalizedTaskId,
      turnId: normalizedTurnId,
      routeContextId: normalized.routeContextId,
      status: normalized.status,
      summary: normalized.summary,
      evidence: normalized.evidence ?? [],
      decisions: normalized.decisions ?? [],
      artifacts: normalized.artifacts ?? [],
      blockers: normalized.blockers ?? [],
      deferred: normalized.deferred ?? [],
      nextCandidates: normalized.nextCandidates ?? [],
      projectTerminal: normalized.projectTerminal ?? false,
    };
    const snapshotHash = hash(statePayload);
    const summaryJson = stableJson({
      summary: normalized.summary,
      decisions: normalized.decisions ?? [],
      artifacts: normalized.artifacts ?? [],
      blockers: normalized.blockers ?? [],
      deferred: normalized.deferred ?? [],
      nextCandidates: normalized.nextCandidates ?? [],
      projectTerminal: normalized.projectTerminal ?? false,
    });
    const evidenceJson = stableJson(normalized.evidence ?? []);
    const terminalAt = isTerminalContinuityTaskStatus(normalized.status) ? now : null;
    const operations: MemoryWorkerSqlOperation[] = [
      {
        kind: 'run',
        sql: `INSERT INTO continuity_checkpoints(
          id, principal_id, project_id, task_id, route_context_id, phase, summary_json, evidence_json, state_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          checkpointId, scope.principalId, scope.projectId ?? null, normalizedTaskId,
          normalized.routeContextId, normalized.status, summaryJson, evidenceJson, snapshotHash, now,
        ],
      },
      {
        kind: 'run',
        sql: `UPDATE continuity_tasks
                 SET status = ?, blocker_json = ?, last_checkpoint_id = ?, updated_at = ?, completed_at = ?
               WHERE id = ? AND principal_id = ? AND IFNULL(project_id, '') = ?`,
        params: [
          normalized.status, stableJson(normalized.blockers ?? []), checkpointId, now, terminalAt,
          normalizedTaskId, scope.principalId, scopeProject(scope),
        ],
      },
      eventOperation(scope, 'continuity.checkpoint_created', checkpointId, 'continuity checkpoint created', {
        checkpointId, taskId: normalizedTaskId, turnId: normalizedTurnId,
        routeContextId: normalized.routeContextId, status: normalized.status, stateHash: snapshotHash,
      }, now),
    ];

    if (task.status !== normalized.status) {
      operations.push(eventOperation(scope, 'continuity.task_state_changed', normalizedTaskId, 'continuity task state changed', {
        taskId: normalizedTaskId, from: task.status, to: normalized.status,
        checkpointId, routeContextId: normalized.routeContextId,
      }, now + 1));
    }

    (normalized.nextCandidates ?? []).forEach((candidate, index) => {
      const frontierId = randomUUID();
      const createdAt = now + 2 + index;
      operations.push({
        kind: 'run',
        sql: `INSERT INTO continuity_frontier(
          id, principal_id, project_id, source_task_id, title, rationale, status,
          dependency_task_ids_json, priority, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?)`,
        params: [
          frontierId, scope.principalId, scope.projectId ?? null, normalizedTaskId,
          candidate.title, candidate.rationale, stableJson(candidate.dependsOnTaskIds ?? []),
          candidate.priority ?? 0, createdAt, createdAt,
        ],
      });
      operations.push(eventOperation(scope, 'continuity.frontier_added', frontierId, 'continuity frontier added', {
        frontierId, sourceTaskId: normalizedTaskId, title: candidate.title,
        dependencyTaskIds: candidate.dependsOnTaskIds ?? [], priority: candidate.priority ?? 0,
      }, createdAt));
    });

    await this.client.transaction(operations);
    return { checkpointId, taskStatus: normalized.status, snapshotHash };
  }

  async closeTurn(
    scope: MemoryScope,
    turnId: string,
    finalState: Exclude<ContinuityTurnState, 'open'>,
  ): Promise<void> {
    assertScope(scope);
    const normalizedTurnId = text(turnId, 'turnId', 5_000);
    if (finalState !== 'closed' && finalState !== 'interrupted') {
      fail('CONTINUITY_TURN_STATE_INVALID', 'Turn final state must be closed or interrupted');
    }
    const turn = await this.findTurn(scope, normalizedTurnId);
    if (!turn) fail('CONTINUITY_TURN_NOT_FOUND', 'Turn was not found in authenticated scope');
    if (turn.state === finalState) return;
    if (turn.state !== 'open') fail('CONTINUITY_TURN_ALREADY_FINAL', 'Turn is already finalized');
    const task = await this.findTask(scope, turn.task_id);
    if (!task) fail('CONTINUITY_TASK_NOT_FOUND', 'Turn task was not found in authenticated scope');
    if (finalState === 'closed' && !isTerminalContinuityTaskStatus(task.status)) {
      fail('CONTINUITY_TASK_NOT_TERMINAL', 'A cleanly closed turn requires a terminal task checkpoint');
    }

    const now = Date.now();
    const operations: MemoryWorkerSqlOperation[] = [{
      kind: 'run',
      sql: `UPDATE continuity_turns SET state = ?, closed_at = ?
            WHERE id = ? AND principal_id = ? AND IFNULL(project_id, '') = ? AND state = 'open'`,
      params: [finalState, now, normalizedTurnId, scope.principalId, scopeProject(scope)],
    }];

    if (finalState === 'interrupted' && !isTerminalContinuityTaskStatus(task.status) && task.status !== 'interrupted') {
      assertTransition(task.status, 'interrupted');
      operations.push({
        kind: 'run',
        sql: `UPDATE continuity_tasks SET status = 'interrupted', updated_at = ?, completed_at = NULL
              WHERE id = ? AND principal_id = ? AND IFNULL(project_id, '') = ?`,
        params: [now, task.taskId, scope.principalId, scopeProject(scope)],
      });
      operations.push(eventOperation(scope, 'continuity.task_state_changed', task.taskId, 'continuity task interrupted', {
        taskId: task.taskId, from: task.status, to: 'interrupted', turnId: normalizedTurnId,
      }, now));
    }
    operations.push(eventOperation(
      scope,
      finalState === 'closed' ? 'continuity.turn_closed' : 'continuity.turn_interrupted',
      normalizedTurnId,
      finalState === 'closed' ? 'continuity turn closed' : 'continuity turn interrupted',
      { turnId: normalizedTurnId, taskId: task.taskId, finalState },
      now + 1,
    ));
    await this.client.transaction(operations);
  }

  async getTask(scope: MemoryScope, taskId: string): Promise<ContinuityTaskRecord | null> {
    assertScope(scope);
    return this.findTask(scope, text(taskId, 'taskId', 5_000));
  }

  async listFrontier(scope: MemoryScope, limit = 5): Promise<ContinuityFrontierRecord[]> {
    assertScope(scope);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      fail('CONTINUITY_LIMIT_INVALID', 'Frontier limit must be an integer between 1 and 100');
    }
    const rows = await this.client.query<Record<string, unknown>>(
      `SELECT id, source_task_id, title, rationale, status, dependency_task_ids_json,
              priority, created_at, updated_at
         FROM continuity_frontier
        WHERE principal_id = ? AND IFNULL(project_id, '') = ?
          AND status IN ('candidate', 'approved', 'deferred')
        ORDER BY priority DESC, created_at ASC, id COLLATE BINARY ASC
        LIMIT ?`,
      [scope.principalId, scopeProject(scope), limit],
    );
    return rows.map((row) => ({
      frontierId: String(row.id),
      sourceTaskId: String(row.source_task_id),
      title: String(row.title),
      rationale: String(row.rationale),
      status: String(row.status) as FrontierStatus,
      dependencyTaskIds: jsonArray(String(row.dependency_task_ids_json)).map(String),
      priority: Number(row.priority),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }));
  }

  private async findTask(scope: MemoryScope, taskId: string): Promise<ContinuityTaskRecord | null> {
    const rows = await this.client.query<TaskRow>(
      `SELECT id, principal_id, project_id, parent_task_id, title, objective, acceptance_json,
              constraints_json, status, priority, blocker_json, last_checkpoint_id,
              created_at, updated_at, completed_at
         FROM continuity_tasks
        WHERE id = ? AND principal_id = ? AND IFNULL(project_id, '') = ?
        LIMIT 1`,
      [taskId, scope.principalId, scopeProject(scope)],
    );
    return rows[0] ? mapTask(rows[0]) : null;
  }

  private async findTurn(scope: MemoryScope, turnId: string): Promise<TurnRow | null> {
    const rows = await this.client.query<TurnRow>(
      `SELECT id, principal_id, project_id, route_context_id, task_id, state
         FROM continuity_turns
        WHERE id = ? AND principal_id = ? AND IFNULL(project_id, '') = ?
        LIMIT 1`,
      [turnId, scope.principalId, scopeProject(scope)],
    );
    return rows[0] ?? null;
  }
}
