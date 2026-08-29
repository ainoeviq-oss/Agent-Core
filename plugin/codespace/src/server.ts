import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createCodespaceMcpServer } from './mcp-server.js';

async function main(): Promise<void> {
  const server = await createCodespaceMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[codespace] MCP startup failed: ${message}`);
  process.exitCode = 1;
});
