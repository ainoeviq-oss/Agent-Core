import { createHash } from 'node:crypto';
import type { MemoryScope } from '../memory/types.js';
import type { MemoryWorkerClient } from '../memory/worker-client.js';
import type { ContinuityFrontierRecord, ContinuityTaskRecord } from './store.js';
import type { ContinuityTaskStatus, FrontierStatus } from './types.js';

export const CONTINUITY_SNAPSHOT_LIMITS = {
  active: 10,
  completed: 10,
  blocked: 10,
  deferred: 10,
  unfinished: 10,
  frontier: 5,
  interrupted: 5,
  characterBudget: 20_000,
} as const;

export interface ContinuityInterruptedTurnRecord {
  turnId: string;
  taskId: string;
  routeContextId: string;
  createdAt: number;
  closedAt?: number;
}

export interface ContinuitySnapshot {
  currentObjective: string | null;
  activeTasks: ContinuityTaskRecord[];
  recentCompleted: ContinuityTaskRecord[];
  blockedTasks: ContinuityTaskRecord[];
  deferredTasks: ContinuityTaskRecord[];
  unfinishedPlans: ContinuityTaskRecord[];
  frontier: ContinuityFrontierRecord[];
  interruptedTurns: ContinuityInterruptedTurnRecord[];
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

function scopeProject(scope: MemoryScope): string {
  return scope.projectId ?? '';
}

function assertScope(scope: MemoryScope): void {
  if (!scope?.principalId?.trim()) throw new Error('CONTINUITY_SCOPE_REQUIRED');
}

function parseArray(value: unknown): unknown[] {
  if (typeof value !== 'string') return [];
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
    acceptanceCriteria: parseArray(row.acceptance_json).map(String),
    constraints: parseArray(row.constraints_json).map(String),
    status: row.status,
    priority: Number(row.priority),
    blockers: parseArray(row.blocker_json).filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item))),
    lastCheckpointId: row.last_checkpoint_id ?? undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    completedAt: row.completed_at == null ? undefined : Number(row.completed_at),
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`;
}

function hash(value: unknown): string {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

function objectiveFrom(payload: Omit<ContinuitySnapshot, 'snapshotHash' | 'currentObjective'>): string | null {
  const task = payload.activeTasks[0]
    ?? payload.blockedTasks[0]
    ?? payload.deferredTasks[0]
    ?? payload.unfinishedPlans[0];
  if (!task) return null;
  const value = task.objective || task.title;
  if (value.length <= 2_000) return value;
  return `${value.slice(0, 1_999)}…`;
}

function payloadLength(payload: Omit<ContinuitySnapshot, 'snapshotHash'>): number {
  return JSON.stringify(payload).length;
}

export class ContinuitySnapshotBuilder {
  constructor(readonly client: MemoryWorkerClient) {}

  async build(scope: MemoryScope): Promise<ContinuitySnapshot> {
    assertScope(scope);
    const project = scopeProject(scope);
    const [activeTasks, recentCompleted, blockedTasks, deferredTasks, unfinishedPlans, frontier, interruptedTurns] = await Promise.all([
      this.loadTasks(scope, ['running'], CONTINUITY_SNAPSHOT_LIMITS.active, false),
      this.loadTasks(scope, ['completed'], CONTINUITY_SNAPSHOT_LIMITS.completed, true),
      this.loadTasks(scope, ['blocked'], CONTINUITY_SNAPSHOT_LIMITS.blocked, false),
      this.loadTasks(scope, ['deferred'], CONTINUITY_SNAPSHOT_LIMITS.deferred, false),
      this.loadTasks(scope, ['planned', 'ready', 'failed', 'interrupted'], CONTINUITY_SNAPSHOT_LIMITS.unfinished, false),
      this.client.query<Record<string, unknown>>(
        `SELECT id, source_task_id, title, rationale, status, dependency_task_ids_json,
                priority, created_at, updated_at
           FROM continuity_frontier
          WHERE principal_id = ? AND IFNULL(project_id, '') = ?
            AND status IN ('candidate', 'approved', 'deferred')
          ORDER BY priority DESC, updated_at DESC, created_at ASC, id COLLATE BINARY ASC
          LIMIT ?`,
        [scope.principalId, project, CONTINUITY_SNAPSHOT_LIMITS.frontier],
      ).then((rows) => rows.map((row): ContinuityFrontierRecord => ({
        frontierId: String(row.id),
        sourceTaskId: String(row.source_task_id),
        title: String(row.title),
        rationale: String(row.rationale),
        status: String(row.status) as FrontierStatus,
        dependencyTaskIds: parseArray(row.dependency_task_ids_json).map(String),
        priority: Number(row.priority),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
      }))),
      this.client.query<Record<string, unknown>>(
        `SELECT id, task_id, route_context_id, created_at, closed_at
           FROM continuity_turns
          WHERE principal_id = ? AND IFNULL(project_id, '') = ? AND state = 'interrupted'
          ORDER BY closed_at DESC, created_at DESC, id COLLATE BINARY ASC
          LIMIT ?`,
        [scope.principalId, project, CONTINUITY_SNAPSHOT_LIMITS.interrupted],
      ).then((rows) => rows.map((row): ContinuityInterruptedTurnRecord => ({
        turnId: String(row.id),
        taskId: String(row.task_id),
        routeContextId: String(row.route_context_id),
        createdAt: Number(row.created_at),
        closedAt: row.closed_at == null ? undefined : Number(row.closed_at),
      }))),
    ]);

    const bounded = {
      activeTasks: [...activeTasks],
      recentCompleted: [...recentCompleted],
      blockedTasks: [...blockedTasks],
      deferredTasks: [...deferredTasks],
      unfinishedPlans: [...unfinishedPlans],
      frontier: [...frontier],
      interruptedTurns: [...interruptedTurns],
    };

    const removeOrder: Array<keyof typeof bounded> = [
      'recentCompleted',
      'interruptedTurns',
      'unfinishedPlans',
      'frontier',
      'deferredTasks',
      'blockedTasks',
      'activeTasks',
    ];

    while (true) {
      const currentObjective = objectiveFrom(bounded);
      const candidate = { currentObjective, ...bounded };
      if (payloadLength(candidate) <= CONTINUITY_SNAPSHOT_LIMITS.characterBudget) break;
      const removable = removeOrder.find((key) => bounded[key].length > 0);
      if (!removable) break;
      bounded[removable].pop();
    }

    const currentObjective = objectiveFrom(bounded);
    const payload = { currentObjective, ...bounded };
    return { ...payload, snapshotHash: hash(payload) };
  }

  private async loadTasks(
    scope: MemoryScope,
    statuses: ContinuityTaskStatus[],
    limit: number,
    completedOrder: boolean,
  ): Promise<ContinuityTaskRecord[]> {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(',');
    const order = completedOrder
      ? 'completed_at DESC, updated_at DESC, id COLLATE BINARY ASC'
      : 'priority DESC, updated_at DESC, id COLLATE BINARY ASC';
    const rows = await this.client.query<TaskRow>(
      `SELECT id, principal_id, project_id, parent_task_id, title, objective, acceptance_json,
              constraints_json, status, priority, blocker_json, last_checkpoint_id,
              created_at, updated_at, completed_at
         FROM continuity_tasks
        WHERE principal_id = ? AND IFNULL(project_id, '') = ? AND status IN (${placeholders})
        ORDER BY ${order}
        LIMIT ?`,
      [scope.principalId, scopeProject(scope), ...statuses, limit],
    );
    return rows.map(mapTask);
  }
}
