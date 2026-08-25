import { mkdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { FileKeyStore } from './auth/key-store.js';
import { loadConfig, type AppConfig } from './config.js';
import { createHttpHandler } from './http/app.js';
import { FileAuditLogger } from './logging/audit-log.js';
import { createMcpHttpHandler } from './mcp/handler.js';
import { OAuthService } from './oauth/service.js';
import { FileOAuthStore } from './oauth/store.js';
import { createRuntimeServices, type RuntimeServices } from './runtime/services.js';

export interface AgentCoreService {
  server: Server;
  host: string;
  port: number;
  memory: RuntimeServices['memory'];
  close(): Promise<void>;
}

export async function startAgentCoreService(config: AppConfig = loadConfig()): Promise<AgentCoreService> {
  await Promise.all([
    mkdir(config.dataDir, { recursive: true }),
    mkdir(config.logDir, { recursive: true }),
    mkdir(config.capabilityDir, { recursive: true }),
  ]);

  const keyStore = new FileKeyStore(config.dataDir);
  const oauthStore = new FileOAuthStore(config.dataDir);
  const oauthService = new OAuthService(keyStore, oauthStore);
  const auditLogger = new FileAuditLogger(config.logDir);
  const runtime = createRuntimeServices(config.allowedRoots, config.capabilityDir, auditLogger, config.memory);
  const server = createServer(createHttpHandler({
    keyStore,
    oauthService,
    auditLogger,
    mcpHandler: createMcpHttpHandler(runtime),
  }));

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(config.port, config.host);
  });

  const address = server.address() as AddressInfo;
  return {
    server,
    host: config.host,
    port: address.port,
    memory: runtime.memory,
    close: async () => {
      await closeServer(server);
      await runtime.memory.close();
    },
  };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  try {
    const service = await startAgentCoreService();
    process.stdout.write(`Agent Core listening on http://${service.host}:${service.port}/mcp\n`);
    let closing = false;
    const gracefulClose = async () => {
      if (closing) return;
      closing = true;
      await service.close();
    };
    process.once('SIGINT', () => { void gracefulClose(); });
    process.once('SIGTERM', () => { void gracefulClose(); });
  } catch (error) {
    process.stderr.write(`Agent Core failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
