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
import { watchShutdownRequest, type ShutdownRequestWatcher } from './runtime/shutdown-request.js';

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
  // Warm the in-process memory worker during Agent Core startup. Memory status is fail-closed:
  // an unhealthy DB degrades only DMF while OAuth/MCP and the listener continue to start.
  await runtime.memory.status();
  const server = createServer(createHttpHandler({
    keyStore,
    oauthService,
    auditLogger,
    healthProvider: async () => {
      const memory = await runtime.memory.status();
      return { memory: { ...memory, state: runtime.memory.currentState } };
    },
    mcpHandler: createMcpHttpHandler(runtime),
  }));

  try {
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
  } catch (error) {
    await runtime.memory.close();
    throw error;
  }

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
    let shutdownWatcher: ShutdownRequestWatcher | undefined;
    const gracefulClose = async () => {
      if (closing) return;
      closing = true;
      try {
        await service.close();
        shutdownWatcher?.close();
      } catch (error) {
        closing = false;
        throw error;
      }
    };
    const reportCloseError = (error: unknown) => {
      process.stderr.write(`Agent Core failed to close cleanly: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    };
    const shutdownRequestPath = process.env.AGENT_CORE_SHUTDOWN_REQUEST_PATH?.trim();
    if (shutdownRequestPath) {
      shutdownWatcher = watchShutdownRequest(shutdownRequestPath, gracefulClose);
    }
    process.once('SIGINT', () => { void gracefulClose().catch(reportCloseError); });
    process.once('SIGTERM', () => { void gracefulClose().catch(reportCloseError); });
  } catch (error) {
    process.stderr.write(`Agent Core failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
