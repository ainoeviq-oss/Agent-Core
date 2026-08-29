import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { PresentationBridgeService } from '../application/service.js';
import type { JobTarget } from '../types/contracts.js';
import { serializeError } from '../security/errors.js';

export interface HostedServerOptions {
  service: PresentationBridgeService;
  host?: string;
  port?: number;
  uiRoot?: string;
  serveUi?: boolean;
  authToken?: string;
}

export interface HostedServerHandle {
  host: string;
  port: number;
  baseUrl: string;
  close(): Promise<void>;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  response.end(body);
}

function text(response: ServerResponse, status: number, value: string, contentType = 'text/plain; charset=utf-8'): void {
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(value),
    'cache-control': 'no-store'
  });
  response.end(value);
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function targetFrom(value: string | null): JobTarget | null {
  return value === 'google' || value === 'keynote' || value === 'all' ? value : null;
}

function modeFrom(value: string | null): 'live' | 'mock' | undefined {
  return value === 'mock' ? 'mock' : value === 'live' ? 'live' : undefined;
}

function authorized(request: IncomingMessage, authToken: string | undefined, url: URL): boolean {
  if (!authToken) return true;
  return request.headers.authorization === `Bearer ${authToken}` || url.searchParams.get('token') === authToken;
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.woff2': return 'font/woff2';
    default: return 'application/octet-stream';
  }
}

async function receivePptxUpload(request: IncomingMessage, service: PresentationBridgeService): Promise<{ sourcePath: string; uploadDir: string }> {
  const rawName = request.headers['x-pb-filename'];
  const requestedName = Array.isArray(rawName) ? rawName[0] : rawName;
  const safeName = (requestedName ?? '').replaceAll('\\', '/').split('/').at(-1)?.trim() ?? '';
  if (!safeName || extname(safeName).toLowerCase() !== '.pptx') {
    const error = new Error('Only .pptx uploads are accepted.');
    error.name = 'UnsupportedMediaTypeError';
    throw error;
  }

  const declaredLength = Number.parseInt(request.headers['content-length'] ?? '0', 10);
  if (Number.isFinite(declaredLength) && declaredLength > service.config.limits.maxSourceBytes) {
    const error = new Error(`PPTX exceeds configured source limit (${service.config.limits.maxSourceBytes} bytes).`);
    error.name = 'PayloadTooLargeError';
    throw error;
  }

  const uploadDir = join(dirname(service.config.runtimeRoot), 'uploads', randomUUID());
  await mkdir(uploadDir, { recursive: true, mode: 0o700 });
  const sourcePath = join(uploadDir, safeName);
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > service.config.limits.maxSourceBytes) {
        callback(new Error(`PPTX exceeds configured source limit (${service.config.limits.maxSourceBytes} bytes).`));
        return;
      }
      callback(null, chunk);
    }
  });
  try {
    await pipeline(request, limiter, createWriteStream(sourcePath, { flags: 'wx', mode: 0o600 }));
    return { sourcePath, uploadDir };
  } catch (error) {
    await rm(uploadDir, { recursive: true, force: true });
    throw error;
  }
}

async function serveStaticFile(uiRoot: string, requestPath: string, response: ServerResponse): Promise<void> {
  const relativePath = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
  const normalized = normalize(relativePath);
  if (normalized.startsWith('..') || normalized.includes(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    text(response, 400, 'Invalid path');
    return;
  }
  let filePath = resolve(uiRoot, normalized);
  const root = resolve(uiRoot);
  if (filePath !== root && !filePath.startsWith(`${root}${process.platform === 'win32' ? '\\' : '/'}`)) {
    text(response, 400, 'Invalid path');
    return;
  }
  if (!(await stat(filePath).catch(() => null)) && !extname(normalized)) filePath = join(root, 'index.html');
  if (!(await access(filePath).then(() => true).catch(() => false))) {
    text(response, 404, 'Not found');
    return;
  }
  response.writeHead(200, { 'content-type': contentType(filePath), 'cache-control': extname(filePath) === '.html' ? 'no-store' : 'public, max-age=3600' });
  createReadStream(filePath).pipe(response);
}

export async function startHostedServer(options: HostedServerOptions): Promise<HostedServerHandle> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 4173;
  const serveUi = options.serveUi ?? true;
  const uiRoot = resolve(options.uiRoot ?? join(options.service.config.cwd, 'dist', 'ui'));
  if (!isLoopback(host) && !options.authToken) {
    throw new Error('PB_HOSTED_TOKEN/authToken is required when hosted mode binds beyond loopback.');
  }

  const server = createServer(async (request, response) => {
    try {
      const method = request.method ?? 'GET';
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `${host}:${port}`}`);
      if (url.pathname.startsWith('/api/') && !authorized(request, options.authToken, url)) {
        json(response, 401, { error: { code: 'UNAUTHORIZED', message: 'Hosted API authorization failed.' } });
        return;
      }

      if (method === 'GET' && url.pathname === '/api/health') {
        json(response, 200, { status: 'ok', project: 'Presentation-Bridge', version: '0.2.0' });
        return;
      }
      if (method === 'GET' && url.pathname === '/api/doctor') {
        json(response, 200, await options.service.doctor());
        return;
      }
      if (method === 'GET' && url.pathname === '/api/history') {
        json(response, 200, await options.service.listHistory());
        return;
      }
      if (method === 'GET' && url.pathname === '/api/events') {
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive'
        });
        response.write(': connected\n\n');
        const unsubscribe = options.service.onProgress((event) => {
          response.write(`event: progress\ndata: ${JSON.stringify(event)}\n\n`);
        });
        request.on('close', unsubscribe);
        return;
      }
      if (method === 'POST' && url.pathname === '/api/google/authorize') {
        await options.service.authorizeGoogle();
        json(response, 200, { authorized: true });
        return;
      }
      if (method === 'POST' && url.pathname === '/api/jobs') {
        const target = targetFrom(url.searchParams.get('target'));
        if (!target) {
          json(response, 400, { error: { code: 'INVALID_TARGET', message: 'target must be google, keynote, or all.' } });
          return;
        }
        const { sourcePath, uploadDir } = await receivePptxUpload(request, options.service);
        const googleMode = modeFrom(url.searchParams.get('googleMode'));
        const keynoteMode = modeFrom(url.searchParams.get('keynoteMode'));
        const accepted = options.service.startConversion({
          sourcePath,
          target,
          ...(googleMode ? { googleMode } : {}),
          ...(keynoteMode ? { keynoteMode } : {})
        });
        void options.service.waitForJob(accepted.jobId).finally(async () => {
          await rm(uploadDir, { recursive: true, force: true }).catch(() => undefined);
        });
        json(response, 202, accepted);
        return;
      }

      const reportMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/report\.html$/);
      if (method === 'GET' && reportMatch) {
        const jobId = decodeURIComponent(reportMatch[1]!);
        const active = options.service.getJob(jobId);
        const historic = active?.jobRoot ? undefined : (await options.service.listHistory(200)).find((item) => item.jobId === jobId);
        const jobRoot = active?.jobRoot ?? historic?.jobRoot;
        if (!jobRoot || !resolve(jobRoot).startsWith(resolve(options.service.config.runtimeRoot))) {
          text(response, 404, 'Report not found');
          return;
        }
        const reportPath = join(jobRoot, 'compatibility-report.html');
        const reportHtml = await readFile(reportPath, 'utf8').catch(() => null);
        if (!reportHtml) {
          text(response, 404, 'Report not found');
          return;
        }
        text(response, 200, reportHtml, 'text/html; charset=utf-8');
        return;
      }

      const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
      if (jobMatch) {
        const jobId = decodeURIComponent(jobMatch[1]!);
        if (method === 'GET') {
          const snapshot = options.service.getJob(jobId);
          if (!snapshot) {
            json(response, 404, { error: { code: 'JOB_NOT_FOUND', message: 'Unknown active job.' } });
            return;
          }
          json(response, 200, snapshot);
          return;
        }
        if (method === 'POST' && url.searchParams.get('action') === 'cancel') {
          json(response, 200, { cancelled: options.service.cancel(jobId) });
          return;
        }
      }

      if (serveUi && method === 'GET' && !url.pathname.startsWith('/api/')) {
        await serveStaticFile(uiRoot, url.pathname, response);
        return;
      }
      text(response, 404, 'Not found');
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      const status = name === 'UnsupportedMediaTypeError' ? 415 : name === 'PayloadTooLargeError' ? 413 : 500;
      json(response, status, { error: serializeError(error) });
    }
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Hosted server did not expose a TCP address.');
  const baseUrl = `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`;
  return {
    host,
    port: address.port,
    baseUrl,
    close: async () => await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))
  };
}
