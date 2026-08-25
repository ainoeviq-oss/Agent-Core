import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { VerifiedKey } from '../auth/key-types.js';
import type { MemorySearchHit } from '../memory/types.js';
import type { RuntimeServices } from '../runtime/services.js';

function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}

function memoryConfidence(hits: MemorySearchHit[]): number {
  if (hits.length === 0) return 0;
  const breadth = Math.min(1, hits.length / 5);
  const signalCoverage = hits.filter((hit) => hit.whyMatched.exact > 0 || hit.whyMatched.lexical > 0).length / hits.length;
  const provenanceCoverage = hits.filter((hit) => Boolean(hit.sourceEventId)).length / hits.length;
  return Number((0.4 * breadth + 0.3 * signalCoverage + 0.3 * provenanceCoverage).toFixed(6));
}

function guarded<T>(operation: () => T) {
  try { return textResult(operation()); }
  catch (error) { return errorResult(error); }
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const routeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export const CAPABILITY_TOOL_NAMES = [
  'capability_route', 'capability_search', 'capability_get',
  'skill_load', 'capability_dependencies', 'capability_coverage',
] as const;

const capabilityType = z.enum([
  'skill', 'agent', 'command', 'hook', 'framework', 'collection', 'guide', 'utility',
]);
const capabilityRisk = z.enum(['low', 'medium', 'high', 'unknown']);
const capabilityState = z.enum([
  'cataloged', 'source_resolved', 'license_verified', 'function_analyzed',
  'safety_reviewed', 'normalized', 'native_ready', 'reference_only',
  'quarantined', 'unresolved', 'license_unknown', 'source_removed',
]);

export function registerCapabilityTools(
  server: McpServer,
  runtime: RuntimeServices,
  key: VerifiedKey,
): void {
  server.registerTool('capability_route', {
    title: 'Route Capabilities',
    description: 'Create a principal-bound Agent Core routing context for an actionable task before task-execution tools are used.',
    inputSchema: {
      task: z.string().min(1).max(20_000),
      context: z.string().max(20_000).optional(),
    },
    annotations: routeAnnotations,
  }, async ({ task, context }) => {
    const reservation = runtime.routes.reserve();
    const scope = {
      principalId: key.id,
      projectId: runtime.workspace.roots[0],
    };
    let memoryStatus: 'disabled' | 'healthy' | 'degraded' = runtime.memory.config.enabled ? 'healthy' : 'disabled';
    let preflight = null as Awaited<ReturnType<typeof runtime.memory.preflight>> | null;

    if (runtime.memory.config.enabled) {
      try {
        preflight = await runtime.memory.preflight({
          scope,
          routeContextId: reservation.routeContextId,
          task,
          context,
          routeMetadata: { workspaceRoots: runtime.workspace.roots },
          expiresAt: Date.parse(reservation.expiresAt),
        });
      } catch {
        memoryStatus = 'degraded';
      }
    }

    const plan = runtime.router.route(task, context ?? '');
    const route = runtime.routes.create(key.id, plan, {
      reservation,
      ...(preflight ? {
        memorySnapshot: {
          memoryContextId: preflight.contextId,
          memorySnapshotHash: preflight.snapshotHash,
          blockingGuardrailMemoryIds: preflight.blockingGuardrails.map((item) => item.memoryId),
          blockingGuardrails: preflight.blockingGuardrails.map((item) => ({
            memoryId: item.memoryId,
            revisionId: item.revisionId,
            canonicalKey: item.canonicalKey,
            ...(item.sourceEventId ? { sourceEventId: item.sourceEventId } : {}),
          })),
          enforceHardGuardrails: runtime.memory.config.enforceHardGuardrails,
        },
      } : {}),
    });

    const memorySummary = preflight?.recalled ?? [];
    return textResult({
      routeContextId: route.routeContextId,
      tier: route.tier,
      mode: route.mode,
      domain: route.domain,
      confidence: route.confidence,
      risk: route.risk,
      recommendedCapabilities: route.recommendedCapabilities,
      requiredSkillLoads: route.requiredSkillLoads,
      allowedTools: route.allowedTools,
      verification: route.verification,
      reasonCodes: route.reasonCodes,
      memoryStatus,
      memoryContextId: preflight?.contextId ?? null,
      memorySummary,
      blockingGuardrails: preflight?.blockingGuardrails ?? [],
      openConflicts: preflight?.openConflicts ?? [],
      priorFailures: preflight?.priorFailures ?? [],
      relatedDecisions: preflight?.relatedDecisions ?? [],
      memoryConfidence: memoryConfidence(memorySummary),
      memorySnapshotHash: preflight?.snapshotHash ?? null,
      expiresAt: route.expiresAt,
    });
  });

  server.registerTool('capability_search', {
    title: 'Search Capabilities',
    description: 'Search compact Agent Core capability metadata by function, type, category, risk, state, or agent compatibility.',
    inputSchema: {
      query: z.string().max(20_000).default(''),
      type: capabilityType.optional(),
      category: z.string().max(200).optional(),
      risk: capabilityRisk.optional(),
      state: capabilityState.optional(),
      compatibility: z.string().max(100).optional(),
      limit: z.number().int().min(1).max(100).default(20),
    },
    annotations: readOnlyAnnotations,
  }, async ({ query, type, category, risk, state, compatibility, limit }) => textResult({
    results: runtime.capabilities.search(query, {
      type, category, risk, state, compatibility, limit,
    }),
  }));

  server.registerTool('capability_get', {
    title: 'Get Capability',
    description: 'Return canonical metadata and audit state for one Agent Core capability. This never returns full skill instructions.',
    inputSchema: { id: z.string().min(1).max(200) },
    annotations: readOnlyAnnotations,
  }, async ({ id }) => guarded(() => {
    const capability = runtime.capabilities.get(id);
    if (!capability) throw new Error(`Unknown capability: ${id}`);
    return capability;
  }));
  server.registerTool('skill_load', {
    title: 'Load Audited Skill',
    description: 'Load full instructions only for an audited native-ready skill and optionally bind that load to an Agent Core route context.',
    inputSchema: {
      id: z.string().min(1).max(200),
      routeContextId: z.string().uuid().optional(),
    },
    annotations: readOnlyAnnotations,
  }, async ({ id, routeContextId }) => guarded(() => {
    const loaded = runtime.capabilities.loadSkill(id);
    if (routeContextId) {
      runtime.routes.markSkillLoaded(routeContextId, key.id, id);
    }
    return loaded;
  }));

  server.registerTool('capability_dependencies', {
    title: 'Capability Dependencies',
    description: 'Inspect required Agent Core tools, dependencies, side effects, risk, and eligibility before loading or using a capability.',
    inputSchema: { id: z.string().min(1).max(200) },
    annotations: readOnlyAnnotations,
  }, async ({ id }) => guarded(() => runtime.capabilities.dependencies(id)));

  server.registerTool('capability_coverage', {
    title: 'Capability Coverage',
    description: 'Return catalog coverage totals and audit states for the Agent Core capability registry.',
    annotations: readOnlyAnnotations,
  }, async () => textResult(runtime.capabilities.coverage()));
}
