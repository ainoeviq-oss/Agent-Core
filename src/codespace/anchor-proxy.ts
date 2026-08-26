import http, { type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import https from 'node:https';
import { ANCHOR_PUBLIC_BASE_URL } from './anchor-config.js';

export interface AnchorProxyTarget {
  baseUrl: string;
  mode: 'local' | 'remote';
  advertisedBaseUrl?: string;
}

export interface AnchorProxyOptions {
  publicBaseUrl?: string;
  resolveTarget: () => Promise<AnchorProxyTarget>;
  log?: (message: string) => void;
  metadataLimitBytes?: number;
}

const ALLOWED_PATHS = new Set([
  '/health',
  '/mcp',
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
  '/oauth/register',
  '/oauth/authorize',
  '/oauth/token',
]);

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function sanitizeRequestHeaders(headers: IncomingHttpHeaders, target: URL): http.OutgoingHttpHeaders {
  const output: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === 'host') continue;
    if (value !== undefined) output[name] = value;
  }
  output.host = target.host;
  output['accept-encoding'] = 'identity';
  return output;
}

function sanitizeResponseHeaders(headers: IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const output: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    if (value !== undefined) output[name] = value;
  }
  return output;
}

function replaceOrigin(value: string, target: AnchorProxyTarget, publicBaseUrl: string): string {
  const candidates = [target.advertisedBaseUrl, target.baseUrl]
    .filter((entry): entry is string => Boolean(entry))
    .map((entry) => entry.replace(/\/$/, ''));
  let result = value;
  for (const candidate of candidates) result = result.split(candidate).join(publicBaseUrl);
  return result;
}

function rewriteDiscovery(pathname: string, body: unknown, publicBaseUrl: string): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const value = { ...(body as Record<string, unknown>) };
  if (pathname === '/.well-known/oauth-authorization-server') {
    value.issuer = publicBaseUrl;
    value.authorization_endpoint = `${publicBaseUrl}/oauth/authorize`;
    value.token_endpoint = `${publicBaseUrl}/oauth/token`;
    value.registration_endpoint = `${publicBaseUrl}/oauth/register`;
  } else if (
    pathname === '/.well-known/oauth-protected-resource'
    || pathname === '/.well-known/oauth-protected-resource/mcp'
  ) {
    value.resource = `${publicBaseUrl}/mcp`;
    value.authorization_servers = [publicBaseUrl];
  }
  return value;
}

async function readBounded(response: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new Error('anchor_metadata_response_too_large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function sendJsonError(response: ServerResponse, status: number, error: string): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ error }));
}

export function createAnchorProxy(options: AnchorProxyOptions): Server {
  const publicBaseUrl = (options.publicBaseUrl ?? ANCHOR_PUBLIC_BASE_URL).replace(/\/$/, '');
  const log = options.log ?? (() => {});
  const metadataLimitBytes = options.metadataLimitBytes ?? 128 * 1024;

  return http.createServer(async (request, response) => {
    const incomingUrl = new URL(request.url ?? '/', 'http://anchor.invalid');
    if (!ALLOWED_PATHS.has(incomingUrl.pathname)) {
      sendJsonError(response, 404, 'not_found');
      return;
    }

    let target: AnchorProxyTarget;
    try {
      target = await options.resolveTarget();
    } catch {
      sendJsonError(response, 503, 'backend_unavailable');
      return;
    }

    let targetBase: URL;
    try {
      targetBase = new URL(target.baseUrl);
      if (!['http:', 'https:'].includes(targetBase.protocol)) throw new Error('unsupported_protocol');
    } catch {
      sendJsonError(response, 503, 'backend_invalid');
      return;
    }

    log(`${request.method ?? 'GET'} ${incomingUrl.pathname} backend=${target.mode}`);

    const targetUrl = new URL(`${incomingUrl.pathname}${incomingUrl.search}`, targetBase);
    const client = targetUrl.protocol === 'https:' ? https : http;
    const upstream = client.request(targetUrl, {
      method: request.method,
      headers: sanitizeRequestHeaders(request.headers, targetUrl),
    }, async (upstreamResponse) => {
      const status = upstreamResponse.statusCode ?? 502;
      const headers = sanitizeResponseHeaders(upstreamResponse.headers);
      const challenge = headers['www-authenticate'];
      if (typeof challenge === 'string') {
        headers['www-authenticate'] = replaceOrigin(challenge, target, publicBaseUrl);
      } else if (Array.isArray(challenge)) {
        headers['www-authenticate'] = challenge.map((entry) => replaceOrigin(entry, target, publicBaseUrl));
      }

      const isDiscovery = incomingUrl.pathname === '/.well-known/oauth-authorization-server'
        || incomingUrl.pathname === '/.well-known/oauth-protected-resource'
        || incomingUrl.pathname === '/.well-known/oauth-protected-resource/mcp';

      if (!isDiscovery) {
        response.writeHead(status, headers);
        upstreamResponse.pipe(response);
        return;
      }

      try {
        const raw = await readBounded(upstreamResponse, metadataLimitBytes);
        const parsed = JSON.parse(raw.toString('utf8')) as unknown;
        const rewritten = Buffer.from(JSON.stringify(rewriteDiscovery(incomingUrl.pathname, parsed, publicBaseUrl)));
        delete headers['transfer-encoding'];
        headers['content-length'] = String(rewritten.length);
        headers['content-type'] = 'application/json; charset=utf-8';
        response.writeHead(status, headers);
        response.end(rewritten);
      } catch {
        sendJsonError(response, 502, 'invalid_backend_metadata');
      }
    });

    upstream.on('error', () => sendJsonError(response, 502, 'backend_unreachable'));
    request.on('aborted', () => upstream.destroy());
    request.pipe(upstream);
  });
}
