import { randomUUID } from 'node:crypto';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import type { FileKeyStore } from '../auth/key-store.js';
import type { VerifiedKey } from '../auth/key-types.js';
import type { AuditLogger } from '../logging/audit-log.js';
import type { OAuthService } from '../oauth/service.js';
import { authenticateRequest } from './auth.js';

export type McpHttpHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  key: VerifiedKey,
) => Promise<void>;

export interface HttpHandlerOptions {
  keyStore: FileKeyStore;
  auditLogger: AuditLogger;
  mcpHandler: McpHttpHandler;
  oauthService?: OAuthService;
  healthProvider?: () => Promise<Record<string, unknown>>;
  healthMetricsProvider?: () => Promise<Record<string, unknown>>;
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  });
  response.end(JSON.stringify(body));
}

export function createHttpHandler(options: HttpHandlerOptions): RequestListener {
  return (request, response) => {
    void handleRequest(request, response, options);
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: HttpHandlerOptions,
): Promise<void> {
  const startedAt = Date.now();
  const requestId = randomUUID();
  const route = new URL(request.url ?? '/', 'http://localhost').pathname;
  let key: VerifiedKey | null = null;

  try {
    if (request.method === 'GET' && route === '/health/metrics') {
      const metrics = options.healthMetricsProvider ? await options.healthMetricsProvider() : { overallHealth: 'degraded' };
      sendJson(response, 200, metrics);
      return;
    }

    if (request.method === 'GET' && route === '/health') {
      const diagnostics = options.healthProvider ? await options.healthProvider() : {};
      sendJson(response, 200, { status: 'ok', service: 'agent-core', ...diagnostics });
      return;
    }

    if (options.oauthService && await options.oauthService.handle(request, response)) {
      return;
    }

    if (route === '/mcp') {
      key = await authenticateRequest(request, options.keyStore, options.oauthService);
      if (!key) {
        const headers: Record<string, string> = {};
        if (options.oauthService) {
          headers['www-authenticate'] = options.oauthService.challenge(request);
        }
        sendJson(response, 401, { error: 'unauthorized' }, headers);
        return;
      }
      await options.mcpHandler(request, response, key);
      return;
    }

    sendJson(response, 404, { error: 'not_found' });
  } catch {
    if (!response.headersSent) sendJson(response, 500, { error: 'internal_error' });
    else if (!response.writableEnded) response.end();
  } finally {
    try {
      await options.auditLogger.log({
        timestamp: new Date().toISOString(),
        requestId,
        method: request.method ?? 'UNKNOWN',
        route,
        status: response.statusCode,
        durationMs: Date.now() - startedAt,
        keyId: key?.id ?? null,
        keyName: key?.name ?? null,
      });
    } catch {
      // Audit failures must not leak credentials or crash an already handled request.
    }
  }
}
