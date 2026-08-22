import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpHttpHandler } from '../http/app.js';
import type { RuntimeServices } from '../runtime/services.js';
import { createCommanderMcpServer } from './server.js';

function sendProtocolError(response: Parameters<McpHttpHandler>[1], status: number, message: string): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({
    jsonrpc: '2.0',
    error: { code: -32000, message },
    id: null,
  }));
}

export function createMcpHttpHandler(runtime: RuntimeServices): McpHttpHandler {
  return async (request, response, key) => {
    if (request.method !== 'POST') {
      sendProtocolError(response, 405, 'Method not allowed.');
      return;
    }

    const server = createCommanderMcpServer(key, runtime);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    let closed = false;

    const cleanup = async () => {
      if (closed) return;
      closed = true;
      await Promise.allSettled([transport.close(), server.close()]);
    };
    response.once('close', () => { void cleanup(); });

    try {
      await server.connect(transport);
      await transport.handleRequest(request, response);
    } catch {
      if (!response.headersSent) sendProtocolError(response, 500, 'Internal MCP server error.');
      else if (!response.writableEnded) response.end();
    } finally {
      if (response.writableEnded) await cleanup();
    }
  };
}
