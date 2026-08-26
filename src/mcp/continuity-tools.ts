import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { VerifiedKey } from '../auth/key-types.js';
import { attachExecutionContinuity } from '../continuity/snapshot.js';
import {
  isTerminalContinuityTaskStatus,
  normalizeContinuityCheckpointInput,
  type ContinuityCheckpointInput,
} from '../continuity/types.js';
import { AgentCoreRouteError } from '../runtime/route-context-store.js';
import type { RuntimeServices } from '../runtime/services.js';
import { resolvedProjectScope } from './project-scope.js';

export const CONTINUITY_TOOL_NAMES = [
  'task_checkpoint',
  'continuity_status',
  'continuity_get_task',
  'continuity_frontier',
] as const;

class ContinuityToolError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ContinuityToolError';
  }
}

function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: { ...(code ? { code } : {}), message } }, null, 2) }],
    isError: true as const,
  };
}

async function guarded<T>(operation: () => Promise<T>) {
  try {
    return textResult(await operation());
  } catch (error) {
    return errorResult(error);
  }
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const checkpointAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const checkpointStatus = z.enum(['running', 'blocked', 'deferred', 'completed', 'failed', 'cancelled', 'interrupted']);
const evidenceType = z.enum(['tool', 'file', 'test', 'log', 'hash', 'health']);

function scope(runtime: RuntimeServices, key: VerifiedKey, routeContextId?: string) {
  return resolvedProjectScope(runtime, key, routeContextId);
}

function requireContinuityRoute(runtime: RuntimeServices, key: VerifiedKey, routeContextId: string) {
  const route = runtime.routes.get(routeContextId);
  if (!route) {
    throw new AgentCoreRouteError('ROUTE_NOT_FOUND', 'Route context was not found or has expired');
  }
  if (route.principalId !== key.id) {
    throw new AgentCoreRouteError('ROUTE_PRINCIPAL_MISMATCH', 'Route context belongs to another authenticated principal');
  }
  if (!route.continuityTaskId || !route.continuityTurnId) {
    throw new ContinuityToolError('CONTINUITY_ROUTE_UNBOUND', 'Route does not have a persisted continuity task/turn');
  }
  return route;
}

export function registerContinuityTools(server: McpServer, runtime: RuntimeServices, key: VerifiedKey): void {
  server.registerTool('task_checkpoint', {
    title: 'Task Checkpoint',
    description: 'Persist a route-bound continuity checkpoint with factual evidence and next frontier. Terminal checkpoints close the bound turn only after persistence succeeds.',
    inputSchema: {
      routeContextId: z.string().uuid(),
      status: checkpointStatus,
      summary: z.string().min(1).max(20_000),
      evidence: z.array(z.object({
        type: evidenceType,
        ref: z.string().min(1).max(5_000),
        result: z.string().max(20_000).optional(),
      })).max(100).optional(),
      decisions: z.array(z.object({
        key: z.string().min(1).max(5_000),
        value: z.string().min(1).max(20_000),
        reason: z.string().min(1).max(20_000),
      })).max(100).optional(),
      artifacts: z.array(z.object({
        path: z.string().min(1).max(5_000),
        role: z.string().min(1).max(5_000),
        hash: z.string().max(5_000).optional(),
      })).max(100).optional(),
      outcomes: z.array(z.object({
        key: z.string().min(1).max(5_000),
        value: z.string().min(1).max(20_000),
        evidenceRefs: z.array(z.string().min(1).max(5_000)).min(1).max(100),
      })).max(100).optional(),
      constraints: z.array(z.object({
        key: z.string().min(1).max(5_000),
        value: z.string().min(1).max(20_000),
        reason: z.string().min(1).max(20_000),
        enforcement: z.enum(['soft', 'hard']),
      })).max(100).optional(),
      blockers: z.array(z.object({
        code: z.string().min(1).max(5_000),
        detail: z.string().min(1).max(20_000),
      })).max(100).optional(),
      deferred: z.array(z.object({
        title: z.string().min(1).max(5_000),
        reason: z.string().min(1).max(20_000),
      })).max(100).optional(),
      nextCandidates: z.array(z.object({
        title: z.string().min(1).max(5_000),
        rationale: z.string().min(1).max(20_000),
        dependsOnTaskIds: z.array(z.string().min(1).max(5_000)).max(128).optional(),
        priority: z.number().finite().optional(),
      })).max(5).optional(),
      projectTerminal: z.boolean().optional(),
    },
    annotations: checkpointAnnotations,
  }, async ({ routeContextId, status, summary, evidence, decisions, artifacts, outcomes, constraints, blockers, deferred, nextCandidates, projectTerminal }) => guarded(async () => {
    const route = requireContinuityRoute(runtime, key, routeContextId);
    const input = normalizeContinuityCheckpointInput({
      routeContextId,
      status,
      summary,
      evidence,
      decisions,
      artifacts,
      outcomes,
      constraints,
      blockers,
      deferred,
      nextCandidates,
      projectTerminal,
    } as ContinuityCheckpointInput);
    const currentScope = scope(runtime, key, routeContextId);
    const checkpoint = await runtime.memory.checkpointContinuity(
      currentScope,
      route.continuityTaskId!,
      route.continuityTurnId!,
      input,
    );
    const promoted = await runtime.memory.promoteContinuityCheckpoint(
      currentScope,
      route.continuityTaskId!,
      checkpoint.checkpointId,
      input,
    );

    let turnState: 'open' | 'closed' | 'interrupted' = 'open';
    if (isTerminalContinuityTaskStatus(input.status)) {
      await runtime.memory.closeContinuityTurn(currentScope, route.continuityTurnId!, 'closed');
      turnState = 'closed';
    } else if (input.status === 'interrupted') {
      await runtime.memory.closeContinuityTurn(currentScope, route.continuityTurnId!, 'interrupted');
      turnState = 'interrupted';
    }

    const snapshot = await runtime.memory.getContinuitySnapshot(currentScope);
    return {
      ...checkpoint,
      turnState,
      promoted: {
        decisions: promoted.decisions,
        artifacts: promoted.artifacts,
        outcomes: promoted.outcomes,
        constraints: promoted.constraints,
        failures: promoted.failures,
      },
      promotedMemoryIds: promoted.memoryIds,
      continuitySnapshotHash: snapshot.snapshotHash,
      frontier: snapshot.frontier,
    };
  }));

  server.registerTool('continuity_status', {
    title: 'Continuity Status',
    description: 'Return current principal/project continuity health and bounded deterministic snapshot.',
    inputSchema: { routeContextId: z.string().uuid().optional() },
    annotations: readOnlyAnnotations,
  }, async ({ routeContextId }) => guarded(async () => {
    const currentScope = scope(runtime, key, routeContextId);
    const memory = await runtime.memory.status(currentScope);
    if (!memory.enabled) return { enabled: false, healthy: false, memory, snapshot: null };
    let snapshot = await runtime.memory.getContinuitySnapshot(currentScope);
    if (runtime.execution.config.enabled) {
      try {
        await runtime.execution.open();
        snapshot = attachExecutionContinuity(snapshot, await runtime.execution.continuitySummary(currentScope));
      } catch {
        // Continuity memory remains independently available when execution is degraded.
      }
    }
    return { enabled: true, healthy: memory.healthy, memory, snapshot };
  }));

  server.registerTool('continuity_get_task', {
    title: 'Continuity Get Task',
    description: 'Return one continuity task owned by the authenticated principal in the current project.',
    inputSchema: { taskId: z.string().uuid(), routeContextId: z.string().uuid().optional() },
    annotations: readOnlyAnnotations,
  }, async ({ taskId, routeContextId }) => guarded(async () => {
    const task = await runtime.memory.getContinuityTask(scope(runtime, key, routeContextId), taskId);
    if (!task) throw new ContinuityToolError('CONTINUITY_TASK_NOT_FOUND', 'Continuity task was not found in authenticated scope');
    return task;
  }));

  server.registerTool('continuity_frontier', {
    title: 'Continuity Frontier',
    description: 'Return the bounded deterministic next-work frontier for the authenticated principal and current project.',
    inputSchema: {
      limit: z.number().int().min(1).max(100).default(5),
      routeContextId: z.string().uuid().optional(),
    },
    annotations: readOnlyAnnotations,
  }, async ({ limit, routeContextId }) => guarded(() => runtime.memory.listContinuityFrontier(
    scope(runtime, key, routeContextId), limit,
  )));
}
