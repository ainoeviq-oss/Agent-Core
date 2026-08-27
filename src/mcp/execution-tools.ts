import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import path from 'node:path';
import * as z from 'zod/v4';
import type { VerifiedKey } from '../auth/key-types.js';
import type { ExecutionRunView } from '../execution/service.js';
import { ExecutionStoreError } from '../execution/store.js';
import type { RuntimeServices } from '../runtime/services.js';
import { resolvedProjectScope, resolveRouteExistingPath, resolveRouteTargetPath } from './project-scope.js';
import { WorkflowAdvisor, type WorkflowGuidance } from './workflow-advisor.js';

export const EXECUTION_TOOL_NAMES = [
  'execution_create',
  'execution_start',
  'execution_status',
  'execution_wait',
  'execution_logs',
  'execution_add_nodes',
  'execution_retry',
  'execution_cancel',
  'execution_artifact_find',
  'execution_workflow_advice',
] as const;

export const EXECUTION_MUTATION_TOOL_NAMES = [
  'execution_create',
  'execution_start',
  'execution_add_nodes',
  'execution_retry',
  'execution_cancel',
] as const;

const ROUTE_REQUIRED_DESCRIPTION = 'Obtain routeContextId from capability_route before using this tool.';
const routedDescription = (description: string) => `${description} ${ROUTE_REQUIRED_DESCRIPTION}`;
const TERMINAL_NODE_STATES = new Set(['succeeded', 'failed', 'blocked', 'interrupted', 'cancelled']);

function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? String((error as { code: string }).code)
    : undefined;
  const details = error instanceof Error && 'details' in error
    && (error as { details?: unknown }).details
    && typeof (error as { details?: unknown }).details === 'object'
    && !Array.isArray((error as { details?: unknown }).details)
    ? (error as { details: Record<string, unknown> }).details
    : undefined;
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: { ...(code ? { code } : {}), message, ...(details ? { details } : {}) } }, null, 2) }],
    isError: true as const,
  };
}

async function guarded<T>(operation: () => Promise<T>) {
  try { return textResult(await operation()); }
  catch (error) { return errorResult(error); }
}

async function mutationGuarded<T>(
  runtime: RuntimeServices,
  key: VerifiedKey,
  routeContextId: string,
  toolName: string,
  operation: (route: NonNullable<ReturnType<typeof runtime.routes.get>>) => Promise<T>,
) {
  try {
    const route = runtime.routes.validate(routeContextId, key.id, toolName);
    return textResult(await operation(route));
  } catch (error) {
    return errorResult(error);
  }
}

function scope(runtime: RuntimeServices, key: VerifiedKey, routeContextId?: string) {
  return resolvedProjectScope(runtime, key, routeContextId);
}

async function routeBoundNode(
  runtime: RuntimeServices,
  route: NonNullable<ReturnType<typeof runtime.routes.get>>,
  node: z.infer<typeof nodeSchema>,
) {
  const cwd = await resolveRouteExistingPath(runtime, route, node.cwd);
  const expectedArtifacts = node.expectedArtifacts
    ? await Promise.all(node.expectedArtifacts.map(async (artifact) => ({
      ...artifact,
      path: await resolveRouteTargetPath(
        runtime,
        route,
        path.isAbsolute(artifact.path) ? artifact.path : path.resolve(cwd, artifact.path),
      ),
    })))
    : undefined;
  return { ...node, cwd, ...(expectedArtifacts ? { expectedArtifacts } : {}) };
}

function requireOwnedView(view: ExecutionRunView | null): ExecutionRunView {
  if (!view) throw new ExecutionStoreError('EXECUTION_RUN_NOT_FOUND', 'Execution run was not found in authenticated scope');
  return view;
}

function compact(view: ExecutionRunView) {
  const byId = new Map(view.nodes.map((node) => [node.nodeId, node]));
  const readyNodeIds = view.nodes
    .filter((node) => (node.state === 'queued' || node.state === 'ready')
      && node.dependsOn.every((dependencyId) => byId.get(dependencyId)?.state === 'succeeded'))
    .map((node) => node.nodeId)
    .sort((left, right) => left.localeCompare(right));
  const runningNodeIds = view.nodes
    .filter((node) => node.state === 'running')
    .map((node) => node.nodeId)
    .sort((left, right) => left.localeCompare(right));
  const terminalNodeIds = view.nodes
    .filter((node) => TERMINAL_NODE_STATES.has(node.state))
    .map((node) => node.nodeId)
    .sort((left, right) => left.localeCompare(right));
  return {
    runId: view.runId,
    state: view.state,
    objective: view.objective,
    maxConcurrency: view.maxConcurrency,
    lastEventSequence: view.lastEventSequence,
    continuityTaskId: view.continuityTaskId ?? null,
    originRouteContextId: view.originRouteContextId ?? null,
    readyNodeIds,
    runningNodeIds,
    terminalNodeIds,
    createdAt: view.createdAt,
    startedAt: view.startedAt ?? null,
    finishedAt: view.finishedAt ?? null,
    updatedAt: view.updatedAt,
    evidence: view.evidence,
    ...(view.memoryPreSearch ? { memoryPreSearch: view.memoryPreSearch } : {}),
    nodes: view.nodes.map((node) => ({
      nodeId: node.nodeId,
      purpose: node.purpose,
      state: node.state,
      dependsOn: node.dependsOn,
      attemptCount: node.attemptCount,
      timeoutMs: node.timeoutMs,
      continueOnFailure: node.continueOnFailure,
      lastError: node.lastError ?? null,
      startedAt: node.startedAt ?? null,
      finishedAt: node.finishedAt ?? null,
    })),
  };
}

const ADVISOR_READ_ONLY_TOOLS = [
  'execution_status', 'execution_wait', 'execution_logs', 'execution_artifact_find', 'execution_workflow_advice',
] as const;

function advisorAvailableTools(
  runtime: RuntimeServices,
  key: VerifiedKey,
  routeContextId?: string,
): string[] {
  const available = new Set<string>(ADVISOR_READ_ONLY_TOOLS);
  if (routeContextId) {
    const route = runtime.routes.getOwned(routeContextId, key.id);
    for (const toolName of route.allowedTools) available.add(toolName);
  }
  return [...available].sort((left, right) => left.localeCompare(right));
}

async function workflowAdvice(
  advisor: WorkflowAdvisor,
  runtime: RuntimeServices,
  key: VerifiedKey,
  view: ExecutionRunView,
  routeContextId?: string,
  includeCacheValidation = true,
): Promise<{ adviceStatus: 'healthy' | 'degraded'; guidance: WorkflowGuidance[] }> {
  try {
    const guidance = await advisor.analyzeRun(view, {
      scope: scope(runtime, key, routeContextId),
      routeContextId,
      availableTools: advisorAvailableTools(runtime, key, routeContextId),
      includeCacheValidation,
    });
    return { adviceStatus: 'healthy', guidance };
  } catch {
    return { adviceStatus: 'degraded', guidance: [] };
  }
}

const mutationAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const nodeSchema = z.object({
  id: z.string().min(1).max(128),
  purpose: z.string().min(1).max(5_000),
  command: z.string().min(1).max(20_000),
  cwd: z.string().min(1).max(5_000),
  dependsOn: z.array(z.string().min(1).max(128)).max(128).optional(),
  timeoutMs: z.number().int().min(1).max(10 * 60_000).optional(),
  continueOnFailure: z.boolean().optional(),
  expectedArtifacts: z.array(z.object({
    path: z.string().min(1).max(5_000),
    kind: z.enum(['file', 'directory']).optional(),
    hash: z.literal('sha256').optional(),
    required: z.boolean().optional(),
    artifactType: z.enum(['build', 'test_report', 'log', 'data', 'other']).optional(),
  })).max(32).optional(),
});

const eventType = z.enum([
  'run.created', 'run.started', 'node.queued', 'node.ready', 'node.started',
  'node.output_available', 'node.succeeded', 'node.failed', 'node.blocked',
  'node.interrupted', 'node.retry_started', 'node.cancelled', 'run.completed',
  'run.failed', 'run.blocked', 'run.interrupted', 'run.cancelled',
]);

export function registerExecutionTools(
  server: McpServer,
  runtime: RuntimeServices,
  key: VerifiedKey,
): void {
  const advisor = new WorkflowAdvisor(runtime);
  server.registerTool('execution_create', {
    title: 'Execution Create',
    description: routedDescription('Validate and persist a planned deterministic multi-command DAG without starting any process.'),
    inputSchema: {
      routeContextId: z.string().uuid(),
      objective: z.string().min(1).max(20_000),
      nodes: z.array(nodeSchema).min(1).max(128),
      maxConcurrency: z.number().int().min(1).max(128).optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    },
    annotations: mutationAnnotations,
  }, async ({ routeContextId, objective, nodes, maxConcurrency, metadata }) => mutationGuarded(
    runtime, key, routeContextId, 'execution_create',
    async (route) => {
      const scopedNodes = await Promise.all(nodes.map((node) => routeBoundNode(runtime, route, node)));
      return compact(await runtime.execution.create(scope(runtime, key, routeContextId), {
        objective,
        nodes: scopedNodes,
        maxConcurrency,
        metadata,
        originRouteContextId: routeContextId,
        ...(route.continuityTaskId ? { continuityTaskId: route.continuityTaskId } : {}),
      }));
    },
  ));

  server.registerTool('execution_start', {
    title: 'Execution Start',
    description: routedDescription('Start ready nodes for an owned planned execution run up to its concurrency bound.'),
    inputSchema: {
      routeContextId: z.string().uuid(),
      runId: z.string().uuid(),
    },
    annotations: mutationAnnotations,
  }, async ({ routeContextId, runId }) => mutationGuarded(
    runtime, key, routeContextId, 'execution_start',
    async () => compact(await runtime.execution.start(scope(runtime, key, routeContextId), runId)),
  ));

  server.registerTool('execution_status', {
    title: 'Execution Status',
    description: 'Return compact persisted graph/run state for a run owned by the authenticated principal in the current project.',
    inputSchema: { runId: z.string().uuid(), routeContextId: z.string().uuid().optional() },
    annotations: readOnlyAnnotations,
  }, async ({ runId, routeContextId }) => guarded(async () => {
    const view = requireOwnedView(await runtime.execution.status(scope(runtime, key, routeContextId), runId));
    const compacted = compact(view);
    const advice = await workflowAdvice(advisor, runtime, key, view, routeContextId, false);
    return { ...compacted, workflowAdviceStatus: advice.adviceStatus, workflowAdvice: advice.guidance };
  }));

  server.registerTool('execution_wait', {
    title: 'Execution Wait',
    description: 'Wait for a matching persisted execution event using bounded event-driven long poll; returns current graph state on timeout.',
    inputSchema: {
      runId: z.string().uuid(),
      routeContextId: z.string().uuid().optional(),
      afterSequence: z.number().int().min(0).default(0),
      eventTypes: z.array(eventType).max(18).optional(),
      nodeIds: z.array(z.string().min(1).max(128)).max(128).optional(),
      timeoutMs: z.number().int().min(1).max(60_000).default(60_000),
    },
    annotations: readOnlyAnnotations,
  }, async ({ runId, routeContextId, afterSequence, eventTypes, nodeIds, timeoutMs }) => guarded(async () => {
    const waited = await runtime.execution.wait(
      scope(runtime, key, routeContextId), runId, afterSequence,
      (eventTypes?.length || nodeIds?.length) ? { eventTypes, nodeIds } : undefined,
      timeoutMs,
    );
    return {
      event: waited.event,
      timedOut: waited.timedOut,
      lastEventSequence: waited.lastEventSequence,
      state: compact(waited.state),
    };
  }));

  server.registerTool('execution_logs', {
    title: 'Execution Logs',
    description: 'Read bounded stdout or stderr bytes for one owned execution attempt using a stable byte offset.',
    inputSchema: {
      runId: z.string().uuid(),
      routeContextId: z.string().uuid().optional(),
      nodeId: z.string().min(1).max(128),
      attemptNo: z.number().int().min(1).max(999_999),
      stream: z.enum(['stdout', 'stderr']),
      offset: z.number().int().min(0).default(0),
      maxBytes: z.number().int().min(1).max(1024 * 1024).default(64 * 1024),
    },
    annotations: readOnlyAnnotations,
  }, async ({ runId, routeContextId, nodeId, attemptNo, stream, offset, maxBytes }) => guarded(() => runtime.execution.readLog(
    scope(runtime, key, routeContextId), runId, nodeId, attemptNo, stream, offset, maxBytes,
  )));

  server.registerTool('execution_workflow_advice', {
    title: 'Execution Workflow Advice',
    description: 'Return deterministic read-only workflow guidance for an owned execution run. Suggestions never execute tools or change run state.',
    inputSchema: {
      runId: z.string().uuid(),
      routeContextId: z.string().uuid().optional(),
    },
    annotations: readOnlyAnnotations,
  }, async ({ runId, routeContextId }) => guarded(async () => {
    const view = requireOwnedView(await runtime.execution.status(scope(runtime, key, routeContextId), runId));
    const advice = await workflowAdvice(advisor, runtime, key, view, routeContextId);
    return {
      runId: view.runId,
      state: view.state,
      lastEventSequence: view.lastEventSequence,
      adviceStatus: advice.adviceStatus,
      guidance: advice.guidance,
    };
  }));

  server.registerTool('execution_artifact_find', {
    title: 'Execution Artifact Find',
    description: 'Find compact verified execution artifact metadata or review-only purge suggestions within the authenticated principal/project scope.',
    inputSchema: {
      mode: z.enum(['hash', 'type', 'run', 'purge_suggestions']),
      hash: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
      artifactType: z.enum(['build', 'test_report', 'log', 'data', 'other']).optional(),
      runId: z.string().uuid().optional(),
      olderThanMs: z.number().int().min(0).max(10 * 365 * 24 * 60 * 60 * 1000).optional(),
      routeContextId: z.string().uuid().optional(),
    },
    annotations: readOnlyAnnotations,
  }, async ({ mode, hash, artifactType, runId, olderThanMs, routeContextId }) => guarded(async () => {
    const currentScope = scope(runtime, key, routeContextId);
    if (mode === 'hash') {
      if (!hash) throw new ExecutionStoreError('EXECUTION_ARTIFACT_HASH_REQUIRED', 'hash is required for hash mode');
      return { mode, artifacts: await runtime.execution.artifacts.findByHash(currentScope, hash) };
    }
    if (mode === 'type') {
      if (!artifactType) throw new ExecutionStoreError('EXECUTION_ARTIFACT_TYPE_REQUIRED', 'artifactType is required for type mode');
      return { mode, artifacts: await runtime.execution.artifacts.findByType(currentScope, artifactType) };
    }
    if (mode === 'run') {
      if (!runId) throw new ExecutionStoreError('EXECUTION_ARTIFACT_RUN_REQUIRED', 'runId is required for run mode');
      return { mode, artifacts: await runtime.execution.artifacts.findByRun(currentScope, runId) };
    }
    return { mode, suggestions: await runtime.execution.artifacts.suggestPurge(currentScope, { olderThanMs }) };
  }));

  server.registerTool('execution_add_nodes', {
    title: 'Execution Add Nodes',
    description: routedDescription('Atomically validate and append new nodes to an owned planned or running execution DAG.'),
    inputSchema: {
      routeContextId: z.string().uuid(),
      runId: z.string().uuid(),
      nodes: z.array(nodeSchema).min(1).max(128),
    },
    annotations: mutationAnnotations,
  }, async ({ routeContextId, runId, nodes }) => mutationGuarded(
    runtime, key, routeContextId, 'execution_add_nodes',
    async (route) => {
      const scopedNodes = await Promise.all(nodes.map((node) => routeBoundNode(runtime, route, node)));
      return compact(await runtime.execution.addNodes(
        scope(runtime, key, routeContextId), runId, scopedNodes,
      ));
    },
  ));

  server.registerTool('execution_retry', {
    title: 'Execution Retry',
    description: routedDescription('Explicitly retry one owned failed/interrupted/cancelled node while preserving prior attempt evidence.'),
    inputSchema: {
      routeContextId: z.string().uuid(),
      runId: z.string().uuid(),
      nodeId: z.string().min(1).max(128),
    },
    annotations: mutationAnnotations,
  }, async ({ routeContextId, runId, nodeId }) => mutationGuarded(
    runtime, key, routeContextId, 'execution_retry',
    async () => compact(await runtime.execution.retry(scope(runtime, key, routeContextId), runId, nodeId)),
  ));

  server.registerTool('execution_cancel', {
    title: 'Execution Cancel',
    description: routedDescription('Cancel an owned execution run or one owned execution node without inferring success.'),
    inputSchema: {
      routeContextId: z.string().uuid(),
      runId: z.string().uuid(),
      nodeId: z.string().min(1).max(128).optional(),
    },
    annotations: mutationAnnotations,
  }, async ({ routeContextId, runId, nodeId }) => mutationGuarded(
    runtime, key, routeContextId, 'execution_cancel',
    async () => compact(await runtime.execution.cancel(scope(runtime, key, routeContextId), runId, nodeId)),
  ));
}
