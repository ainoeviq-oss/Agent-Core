import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { VerifiedKey } from '../auth/key-types.js';

export const SERVER_NAME = 'desktop-commander';
export const SERVER_VERSION = '0.2.0';

export function createCommanderMcpServer(key: VerifiedKey): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    title: 'Desktop Commander',
    version: SERVER_VERSION,
  });

  server.registerTool('commander_status', {
    title: 'Commander Status',
    description: 'Report Commander MCP identity, runtime, authentication mode, and authenticated key identity.',
    outputSchema: {
      service: z.string(),
      serverName: z.string(),
      version: z.string(),
      runtime: z.string(),
      authentication: z.string(),
      key: z.object({ id: z.string(), name: z.string() }),
    },
  }, async () => {
    const structuredContent = {
      service: 'commander-mcp',
      serverName: SERVER_NAME,
      version: SERVER_VERSION,
      runtime: `node ${process.version}`,
      authentication: key.authentication ?? 'bearer-api-key',
      key: { id: key.id, name: key.name },
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  });

  server.registerTool('commander_capabilities', {
    title: 'Commander Capabilities',
    description: 'Describe enabled gateway capabilities and capability families intentionally deferred to later stages.',
    outputSchema: {
      stage: z.string(),
      enabled: z.array(z.string()),
      deferred: z.array(z.string()),
    },
  }, async () => {
    const structuredContent = {
      stage: 'v1-oauth-bridge',
      enabled: [
        'mcp.streamable_http',
        'auth.api_key',
        'auth.oauth2',
        'oauth.dynamic_client_registration',
        'oauth.authorization_code_pkce',
        'oauth.refresh_token',
        'tool.commander_status',
        'tool.commander_capabilities',
      ],
      deferred: [
        'filesystem',
        'terminal',
        'process',
        'search',
        'git',
        'workspace',
        'tunnel.runtime',
      ],
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  });

  return server;
}
