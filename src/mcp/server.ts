import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { VerifiedKey } from '../auth/key-types.js';
import type { RuntimeServices } from '../runtime/services.js';
import { CAPABILITY_TOOL_NAMES, registerCapabilityTools } from './capability-tools.js';
import { CONTINUITY_TOOL_NAMES, registerContinuityTools } from './continuity-tools.js';
import { EXECUTION_TOOL_NAMES, registerExecutionTools } from './execution-tools.js';
import { GITHUB_TOOL_NAMES, registerGitHubTools } from './github-tools.js';
import { MEMORY_TOOL_NAMES, registerMemoryTools } from './memory-tools.js';
import { HEALTH_METRICS_TOOL_NAMES, registerHealthMetricsTools } from './health-metrics.js';
import { OPERATIONAL_TOOL_NAMES, registerOperationalTools } from './tools.js';

export const SERVER_NAME = 'agent-core';
export const SERVER_VERSION = '0.5.3';

export function createAgentCoreMcpServer(key: VerifiedKey, runtime: RuntimeServices): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    title: 'Agent Core',
    version: SERVER_VERSION,
  });

  server.registerTool('agent_core_status', {
    title: 'Agent Core Status',
    description: 'Report Agent Core MCP identity, runtime, authentication mode, authenticated key identity, and workspace roots.',
    outputSchema: {
      service: z.string(),
      serverName: z.string(),
      version: z.string(),
      runtime: z.string(),
      authentication: z.string(),
      key: z.object({ id: z.string(), name: z.string() }),
      workspaceRoots: z.array(z.string()),
      memory: z.object({
        enabled: z.boolean(),
        healthy: z.boolean(),
        state: z.string(),
        schemaVersion: z.number(),
        dbPath: z.string(),
        counts: z.record(z.string(), z.number()),
        integrity: z.string(),
        lastIntegrityCheckAt: z.number().optional(),
        lastSuccessfulIntegrityCheckAt: z.number().optional(),
        lastBackupPath: z.string().optional(),
        lastBackupAt: z.number().optional(),
      }),
      continuity: z.object({
        enabled: z.boolean(),
        healthy: z.boolean(),
        snapshotReady: z.boolean(),
        counts: z.record(z.string(), z.number()),
      }),
      execution: z.object({
        enabled: z.boolean(),
        healthy: z.boolean(),
        state: z.string(),
        schemaVersion: z.number(),
        dbPath: z.string(),
        integrity: z.string(),
        activeRuns: z.number(),
        queuedSync: z.number(),
        lastIntegrityCheckAt: z.number().optional(),
      }),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => {
    const currentScope = {
      principalId: key.id,
      projectId: runtime.workspace.roots[0],
    };
    const [memoryStatus, executionStatus] = await Promise.all([
      runtime.memory.status(currentScope),
      runtime.execution.health(currentScope),
    ]);
    let continuityCounts: Record<string, number> = {
      activeTasks: 0, recentCompleted: 0, blockedTasks: 0, deferredTasks: 0,
      unfinishedPlans: 0, frontier: 0, interruptedTurns: 0,
    };
    let snapshotReady = false;
    if (memoryStatus.healthy) {
      try {
        const snapshot = await runtime.memory.getContinuitySnapshot(currentScope);
        continuityCounts = {
          activeTasks: snapshot.activeTasks.length,
          recentCompleted: snapshot.recentCompleted.length,
          blockedTasks: snapshot.blockedTasks.length,
          deferredTasks: snapshot.deferredTasks.length,
          unfinishedPlans: snapshot.unfinishedPlans.length,
          frontier: snapshot.frontier.length,
          interruptedTurns: snapshot.interruptedTurns.length,
        };
        snapshotReady = true;
      } catch {}
    }
    const structuredContent = {
      service: 'agent-core',
      serverName: SERVER_NAME,
      version: SERVER_VERSION,
      runtime: `node ${process.version}`,
      authentication: key.authentication ?? 'bearer-api-key',
      key: { id: key.id, name: key.name },
      workspaceRoots: runtime.workspace.roots,
      memory: { ...memoryStatus, state: runtime.memory.currentState },
      continuity: {
        enabled: memoryStatus.enabled,
        healthy: memoryStatus.healthy && snapshotReady,
        snapshotReady,
        counts: continuityCounts,
      },
      execution: executionStatus,
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  });

  server.registerTool('agent_core_capabilities', {
    title: 'Agent Core Capabilities',
    description: 'Describe Agent Core automatic capability routing, authentication, operational tools, Native GitHub Fabric, deterministic memory, and deferred capability registry.',
    outputSchema: {
      stage: z.string(),
      enabled: z.array(z.string()),
      deferred: z.array(z.string()),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => {
    const structuredContent = {
      stage: 'v5-local-continuity-execution-fabric',
      enabled: [
        'mcp.streamable_http', 'auth.api_key', 'auth.oauth2',
        'oauth.dynamic_client_registration', 'oauth.authorization_code_pkce',
        'oauth.refresh_token', 'workspace.boundaries',
        'capability.registry', 'capability.deferred_loading', 'capability.audit_gate',
        'routing.capability_route',
        'routing.principal_bound_context',
        'routing.execution_gate',
        'memory.deterministic_fabric',
        'continuity.local_ledger',
        'execution.deterministic_fabric',
        'execution.event_driven_wake',
        'execution.evidence_bridge',
        'github.native_fabric',
        ...OPERATIONAL_TOOL_NAMES.map((name) => `tool.${name}`),
        ...GITHUB_TOOL_NAMES.map((name) => `tool.${name}`),
        ...CAPABILITY_TOOL_NAMES.map((name) => `tool.${name}`),
        ...MEMORY_TOOL_NAMES.map((name) => `tool.${name}`),
        ...CONTINUITY_TOOL_NAMES.map((name) => `tool.${name}`),
        ...EXECUTION_TOOL_NAMES.map((name) => `tool.${name}`),
        ...HEALTH_METRICS_TOOL_NAMES.map((name) => `tool.${name}`),
      ],
      deferred: ['git.semantic_tools', 'gui.automation', 'registry.system_admin', 'app.adapters'],
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  });

  registerHealthMetricsTools(server, runtime);
  registerOperationalTools(server, runtime, key);
  registerGitHubTools(server, runtime, key);
  registerCapabilityTools(server, runtime, key);
  registerMemoryTools(server, runtime, key);
  registerContinuityTools(server, runtime, key);
  registerExecutionTools(server, runtime, key);
  return server;
}
