import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { VerifiedKey } from '../auth/key-types.js';
import type { RuntimeServices } from '../runtime/services.js';
import { OPERATIONAL_TOOL_NAMES, registerOperationalTools } from './tools.js';

export const SERVER_NAME = 'desktop-commander';
export const SERVER_VERSION = '0.3.0';

export function createCommanderMcpServer(key: VerifiedKey, runtime: RuntimeServices): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    title: 'Desktop Commander',
    version: SERVER_VERSION,
  });

  server.registerTool('commander_status', {
    title: 'Commander Status',
    description: 'Report Commander MCP identity, runtime, authentication mode, authenticated key identity, and workspace roots.',
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
      service: 'commander-mcp',
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

  server.registerTool('commander_capabilities', {
    title: 'Commander Capabilities',
    description: 'Describe the enabled V2 gateway, authentication, filesystem, search, and process capabilities.',
    outputSchema: {
      stage: z.string(),
      enabled: z.array(z.string()),
      deferred: z.array(z.string()),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => {
    const structuredContent = {
      stage: 'v2-operational-tools',
      enabled: [
        'mcp.streamable_http', 'auth.api_key', 'auth.oauth2',
        'oauth.dynamic_client_registration', 'oauth.authorization_code_pkce',
        'oauth.refresh_token', 'workspace.boundaries',
        ...OPERATIONAL_TOOL_NAMES.map((name) => `tool.${name}`),
      ],
      deferred: ['git.semantic_tools', 'gui.automation', 'registry.system_admin', 'app.adapters'],
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  });

  registerOperationalTools(server, runtime);
  return server;
}
