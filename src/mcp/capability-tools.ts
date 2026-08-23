import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
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

export const CAPABILITY_TOOL_NAMES = [
  'capability_recommend', 'capability_search', 'capability_get',
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

export function registerCapabilityTools(server: McpServer, runtime: RuntimeServices): void {
  server.registerTool('capability_recommend', {
    title: 'Recommend Capabilities',
    description: 'Rank compact skill, agent, command, hook, and reference capability metadata for an actionable task without loading full instructions.',
    inputSchema: {
      task: z.string().min(1).max(20_000),
      context: z.string().max(20_000).optional(),
      limit: z.number().int().min(1).max(20).default(8),
    },
    annotations: readOnlyAnnotations,
  }, async ({ task, context, limit }) => textResult({
    results: runtime.capabilities.recommend(task, context ?? '', limit),
  }));

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
    results: runtime.capabilities.search(query, { type, category, risk, state, compatibility, limit }),
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
    description: 'Load full instructions only for a skill that passed source, license, function, and safety audits and is marked native-ready.',
    inputSchema: { id: z.string().min(1).max(200) },
    annotations: readOnlyAnnotations,
  }, async ({ id }) => guarded(() => runtime.capabilities.loadSkill(id)));

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
