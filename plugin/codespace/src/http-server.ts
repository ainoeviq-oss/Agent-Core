import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { BRIDGE_NAME, BRIDGE_VERSION, RUNTIME_DIR } from './constants.js';
import { createCodespaceMcpServer } from './mcp-server.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 38_765;

function parseHost(value: string | undefined): string {
  const host = value?.trim() || DEFAULT_HOST;
  if (host !== DEFAULT_HOST) {
    throw new Error('CODESPACE_MCP_HTTP_HOST must be 127.0.0.1.');
  }
  return host;
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('CODESPACE_MCP_HTTP_PORT must be an integer between 0 and 65535.');
  }
  return port;
}

function isLoopback(remoteAddress: string | undefined): boolean {
  return remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1';
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function writeUrlFile(filePath: string, url: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${url}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
  await fs.chmod(filePath, 0o600);
}

async function removeUrlFileIfOwned(filePath: string, url: string): Promise<void> {
  try {
    if ((await fs.readFile(filePath, 'utf8')).trim() === url) {
      await fs.rm(filePath, { force: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    writeJson(res, 405, {
      jsonrpc: '2.0',
      error: { code: -32_000, message: 'Method not allowed.' },
      id: null,
    });
    return;
  }

  const server = await createCodespaceMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  };
  res.once('close', () => {
    void close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } finally {
    await close();
  }
}

async function main(): Promise<void> {
  delete process.env.CONTROL_PLANE_API_KEY;
  delete process.env.OPENAI_ADMIN_KEY;

  const host = parseHost(process.env.CODESPACE_MCP_HTTP_HOST);
  const port = parsePort(process.env.CODESPACE_MCP_HTTP_PORT);
  const urlFile = process.env.CODESPACE_MCP_HTTP_URL_FILE?.trim()
    || path.join(RUNTIME_DIR, 'state', 'http-mcp.url');

  const httpServer = createServer((req, res) => {
    void (async () => {
      if (!isLoopback(req.socket.remoteAddress)) {
        writeJson(res, 403, { error: 'Loopback access only.' });
        return;
      }

      const requestUrl = new URL(req.url ?? '/', `http://${host}`);
      if (requestUrl.pathname === '/healthz' && req.method === 'GET') {
        writeJson(res, 200, {
          name: BRIDGE_NAME,
          version: BRIDGE_VERSION,
          status: 'ok',
          transport: 'streamable-http',
          pid: process.pid,
          uptimeSeconds: Math.floor(process.uptime()),
        });
        return;
      }

      if (requestUrl.pathname === '/mcp') {
        await handleMcpRequest(req, res);
        return;
      }

      writeJson(res, 404, { error: 'Not found.' });
    })().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[codespace] HTTP MCP request failed: ${message}`);
      if (!res.headersSent) {
        writeJson(res, 500, {
          jsonrpc: '2.0',
          error: { code: -32_603, message: 'Internal server error.' },
          id: null,
        });
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => resolve());
  });

  const address = httpServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('HTTP MCP listener did not expose a TCP address.');
  }
  const mcpUrl = `http://${host}:${address.port}/mcp`;
  await writeUrlFile(urlFile, mcpUrl);
  console.error(`[codespace] HTTP MCP ready at ${mcpUrl}`);

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    console.error(`[codespace] HTTP MCP stopping on ${signal}`);
    await removeUrlFileIfOwned(urlFile, mcpUrl).catch(() => undefined);
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
      setTimeout(resolve, 2_000).unref();
    });
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void shutdown(signal).finally(() => {
        process.exitCode = 0;
      });
    });
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[codespace] HTTP MCP startup failed: ${message}`);
  process.exitCode = 1;
});
