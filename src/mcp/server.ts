import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { VerifiedKey } from '../auth/key-types.js';
import type { RuntimeServices } from '../runtime/services.js';
import { CAPABILITY_TOOL_NAMES, registerCapabilityTools } from './capability-tools.js';
import { OPERATIONAL_TOOL_NAMES, registerOperationalTools } from './tools.js';

export const SERVER_NAME = 'agent-core';
export const SERVER_VERSION = '0.4.0';

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
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => {
    const structuredContent = {
      service: 'agent-core',
      serverName: SERVER_NAME,
      version: SERVER_VERSION,
      runtime: `node ${process.version}`,
      authentication: key.authentication ?? 'bearer-api-key',
      key: { id: key.id, name: key.name },
      workspaceRoots: runtime.workspace.roots,
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  });

  server.registerTool('agent_core_capabilities', {
    title: 'Agent Core Capabilities',
    description: 'Describe the hybrid Agent Core gateway, authentication, operational tools, and deferred capability registry.',
    outputSchema: {
      stage: z.string(),
      enabled: z.array(z.string()),
      deferred: z.array(z.string()),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => {
    const structuredContent = {
      stage: 'v3-hybrid-capability-registry',
      enabled: [
        'mcp.streamable_http', 'auth.api_key', 'auth.oauth2',
        'oauth.dynamic_client_registration', 'oauth.authorization_code_pkce',
        'oauth.refresh_token', 'workspace.boundaries',
        'capability.registry', 'capability.deferred_loading', 'capability.audit_gate',
        ...OPERATIONAL_TOOL_NAMES.map((name) => `tool.${name}`),
        ...CAPABILITY_TOOL_NAMES.map((name) => `tool.${name}`),
      ],
      deferred: ['git.semantic_tools', 'gui.automation', 'registry.system_admin', 'app.adapters'],
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  });

  registerOperationalTools(server, runtime);
  registerCapabilityTools(server, runtime);
  return server;
}
