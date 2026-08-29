import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const REQUIRED_TOOLS = [
  'codespace_status',
  'read_file',
  'write_file',
  'execute_command',
] as const;

function parseMcpUrl(raw: string | undefined): URL {
  if (!raw) throw new Error('MCP URL argument is required.');
  const url = new URL(raw);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/mcp') {
    throw new Error('MCP URL must be a loopback http://127.0.0.1:<port>/mcp endpoint.');
  }
  return url;
}

async function main(): Promise<void> {
  delete process.env.CONTROL_PLANE_API_KEY;
  delete process.env.OPENAI_ADMIN_KEY;

  const url = parseMcpUrl(process.argv[2]);
  const client = new Client({ name: 'codespace-lifecycle-probe', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(url);

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const names = new Set(tools.tools.map((tool) => tool.name));
    const missing = REQUIRED_TOOLS.filter((name) => !names.has(name));
    if (missing.length > 0) {
      throw new Error(`MCP tool probe is missing required tools: ${missing.join(', ')}`);
    }
    process.stdout.write(`MCP_HTTP_PROBE_OK tools=${tools.tools.length}\n`);
  } finally {
    await client.close().catch(() => undefined);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[codespace] HTTP MCP probe failed: ${message}`);
  process.exitCode = 1;
});
