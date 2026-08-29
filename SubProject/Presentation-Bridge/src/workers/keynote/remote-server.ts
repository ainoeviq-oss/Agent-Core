import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { loadConfig, type BridgeConfig } from '../../config/index.js';
import { analyzePptx } from '../../pptx/preflight/analyze.js';
import { BridgeError, ErrorCode, serializeError } from '../../security/errors.js';
import type { TargetResult } from '../../types/contracts.js';
import { keynoteDoctor, type KeynoteDoctorResult } from './doctor.js';
import { convertWithLocalKeynote } from './local.js';

export interface RemoteKeynoteWorkerTlsOptions {
  certPath: string;
  keyPath: string;
}

export interface RemoteKeynoteWorkerServerOptions {
  host?: string;
  port?: number;
  publicBaseUrl?: string;
  authToken: string;
  artifactRoot: string;
  maxSourceBytes: number;
  tls?: RemoteKeynoteWorkerTlsOptions;
  config?: BridgeConfig;
  doctor?: () => Promise<KeynoteDoctorResult>;
  convert?: (sourcePath: string, outputDir: string) => Promise<TargetResult>;
}

export interface RemoteKeynoteWorkerServerHandle {
  host: string;
  port: number;
  baseUrl: string;
  close(): Promise<void>;
}

interface ArtifactRecord {
  keyPath: string;
  previewPdfPath?: string;
}

function loopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

function tokenMatches(request: IncomingMessage, expectedToken: string): boolean {
  const header = request.headers.authorization ?? '';
  const expected = `Bearer ${expectedToken}`;
  const left = Buffer.from(header);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = `${JSON.stringify(payload)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  response.end(body);
}

function safeFilename(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return null;
  const name = basename(raw.replaceAll('\\', '/')).trim();
  return name && extname(name).toLowerCase() === '.pptx' ? name : null;
}

async function receiveUpload(
  request: IncomingMessage,
  root: string,
  filename: string,
  maxSourceBytes: number
): Promise<{ path: string; cleanupRoot: string }> {
  const declared = Number.parseInt(request.headers['content-length'] ?? '0', 10);
  if (Number.isFinite(declared) && declared > maxSourceBytes) {
    throw new BridgeError(ErrorCode.SOURCE_ZIP_BOMB_RISK, `Source exceeds worker upload limit (${maxSourceBytes} bytes).`);
  }
  const cleanupRoot = join(root, '.incoming', randomUUID());
  await mkdir(cleanupRoot, { recursive: true, mode: 0o700 });
  const path = join(cleanupRoot, filename);
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxSourceBytes) {
        callback(new BridgeError(ErrorCode.SOURCE_ZIP_BOMB_RISK, `Source exceeds worker upload limit (${maxSourceBytes} bytes).`));
        return;
      }
      callback(null, chunk);
    }
  });
  try {
    await pipeline(request, limiter, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
    return { path, cleanupRoot };
  } catch (error) {
    await rm(cleanupRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function sanitizedMetadata(value: Record<string, unknown>): Record<string, unknown> {
  const blocked = /token|secret|authorization|credential|path/i;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !blocked.test(key)).slice(0, 100));
}

async function defaultConvert(sourcePath: string, outputDir: string, config: BridgeConfig): Promise<TargetResult> {
  const manifest = await analyzePptx(sourcePath, config);
  return await convertWithLocalKeynote(sourcePath, manifest, {
    outputDir,
    exportPdfPreview: true
  });
}

async function normalizeNativeArtifacts(result: TargetResult, jobDir: string): Promise<ArtifactRecord> {
  if (result.native !== true || result.verification !== 'live' || !result.artifact) {
    throw new BridgeError(ErrorCode.KEYNOTE_OUTPUT_MISSING, 'Worker conversion did not produce a verified native Keynote artifact.');
  }
  const sourceArtifact = resolve(result.artifact);
  const info = await stat(sourceArtifact).catch(() => null);
  if (!info?.isFile() || info.size <= 0 || extname(sourceArtifact).toLowerCase() !== '.key') {
    throw new BridgeError(
      ErrorCode.KEYNOTE_OUTPUT_MISSING,
      'Remote delivery requires Keynote to save the presentation as a non-empty single-file .key document.',
      { outputKind: info?.isDirectory() ? 'package-directory' : info ? 'file' : 'missing' }
    );
  }
  const keyPath = join(jobDir, 'output.key');
  if (sourceArtifact !== resolve(keyPath)) await copyFile(sourceArtifact, keyPath);

  let previewPdfPath: string | undefined;
  const previewCandidate = typeof result.metadata.previewPdf === 'string' ? resolve(result.metadata.previewPdf) : undefined;
  if (previewCandidate) {
    const previewInfo = await stat(previewCandidate).catch(() => null);
    if (previewInfo?.isFile() && previewInfo.size > 0) {
      previewPdfPath = join(jobDir, 'preview.pdf');
      if (previewCandidate !== resolve(previewPdfPath)) await copyFile(previewCandidate, previewPdfPath);
    }
  }
  return { keyPath, ...(previewPdfPath ? { previewPdfPath } : {}) };
}

function artifactPath(root: string, jobId: string, filename: 'output.key' | 'preview.pdf'): string | null {
  if (!/^[a-f0-9-]{36}$/i.test(jobId)) return null;
  const candidate = resolve(root, jobId, filename);
  const expectedRoot = resolve(root);
  return candidate.startsWith(`${expectedRoot}${process.platform === 'win32' ? '\\' : '/'}`) ? candidate : null;
}

export async function startRemoteKeynoteWorkerServer(options: RemoteKeynoteWorkerServerOptions): Promise<RemoteKeynoteWorkerServerHandle> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 4815;
  const token = options.authToken.trim();
  if (!token) throw new Error('Remote Keynote worker authentication token is required.');
  if (!Number.isInteger(options.maxSourceBytes) || options.maxSourceBytes <= 0) throw new Error('maxSourceBytes must be a positive integer.');
  const useTls = Boolean(options.tls);
  if (!loopbackHost(host) && !useTls) throw new Error('TLS is required when the Keynote worker binds beyond loopback.');
  await mkdir(options.artifactRoot, { recursive: true, mode: 0o700 });

  const config = options.config ?? loadConfig(process.cwd());
  const doctor = options.doctor ?? keynoteDoctor;
  const convert = options.convert ?? ((sourcePath: string, outputDir: string) => defaultConvert(sourcePath, outputDir, config));
  const artifacts = new Map<string, ArtifactRecord>();

  let externallyVisibleBase = options.publicBaseUrl?.replace(/\/+$/, '');
  if (externallyVisibleBase) {
    const publicUrl = new URL(externallyVisibleBase);
    if (!loopbackHost(host) && publicUrl.protocol !== 'https:') throw new Error('Remote Keynote worker publicBaseUrl must use HTTPS for non-loopback service.');
  }

  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      if (!tokenMatches(request, token)) {
        sendJson(response, 401, { error: { code: 'UNAUTHORIZED', message: 'Worker authorization failed.' } });
        return;
      }
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'worker'}`);
      if (request.method === 'GET' && url.pathname === '/v1/health') {
        sendJson(response, 200, await doctor());
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/convert') {
        const filename = safeFilename(request.headers['x-pb-filename']);
        if (!filename) {
          sendJson(response, 415, { error: { code: ErrorCode.SOURCE_UNSUPPORTED_EXTENSION, message: 'Worker accepts only .pptx source uploads.' } });
          return;
        }
        const upload = await receiveUpload(request, options.artifactRoot, filename, options.maxSourceBytes);
        const jobId = randomUUID();
        const jobDir = join(options.artifactRoot, jobId);
        await mkdir(jobDir, { recursive: true, mode: 0o700 });
        try {
          const result = await convert(upload.path, jobDir);
          if (!result.native || result.verification !== 'live') {
            sendJson(response, result.status === 'unavailable' ? 503 : 422, {
              native: false,
              status: result.status,
              warnings: result.warnings,
              error: result.error,
              metadata: sanitizedMetadata(result.metadata)
            });
            return;
          }
          const record = await normalizeNativeArtifacts(result, jobDir);
          artifacts.set(jobId, record);
          const rootUrl = externallyVisibleBase ?? (() => {
            const scheme = useTls ? 'https' : 'http';
            return `${scheme}://${request.headers.host ?? `${host}:${port}`}`;
          })();
          sendJson(response, 200, {
            native: true,
            status: result.status,
            ...(result.slideCount !== undefined ? { slideCount: result.slideCount } : {}),
            downloadUrl: `${rootUrl}/v1/artifacts/${jobId}/output.key`,
            ...(record.previewPdfPath ? { previewPdfUrl: `${rootUrl}/v1/artifacts/${jobId}/preview.pdf` } : {}),
            warnings: result.warnings,
            metadata: sanitizedMetadata(result.metadata)
          });
        } finally {
          await rm(upload.cleanupRoot, { recursive: true, force: true }).catch(() => undefined);
        }
        return;
      }

      const artifactMatch = url.pathname.match(/^\/v1\/artifacts\/([^/]+)\/(output\.key|preview\.pdf)$/);
      if (request.method === 'GET' && artifactMatch) {
        const jobId = artifactMatch[1]!;
        const filename = artifactMatch[2] as 'output.key' | 'preview.pdf';
        const record = artifacts.get(jobId);
        const path = record ? (filename === 'output.key' ? record.keyPath : record.previewPdfPath) : artifactPath(options.artifactRoot, jobId, filename);
        if (!path || !(await access(path).then(() => true).catch(() => false))) {
          sendJson(response, 404, { error: { code: 'ARTIFACT_NOT_FOUND', message: 'Worker artifact was not found.' } });
          return;
        }
        const info = await stat(path);
        response.writeHead(200, {
          'content-type': filename === 'output.key' ? 'application/x-iwork-keynote-sffkey' : 'application/pdf',
          'content-length': String(info.size),
          'content-disposition': `attachment; filename="${filename}"`,
          'cache-control': 'no-store'
        });
        createReadStream(path).pipe(response);
        return;
      }
      sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Unknown Keynote worker endpoint.' } });
    } catch (error) {
      sendJson(response, 500, { error: serializeError(error) });
    }
  };

  const server = options.tls
    ? createHttpsServer({
        cert: await readFile(options.tls.certPath),
        key: await readFile(options.tls.keyPath)
      }, (request, response) => { void handler(request, response); })
    : createHttpServer((request, response) => { void handler(request, response); });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Keynote worker did not expose a TCP address.');
  if (!externallyVisibleBase) {
    const scheme = useTls ? 'https' : 'http';
    const displayHost = host.includes(':') ? `[${host}]` : host;
    externallyVisibleBase = `${scheme}://${displayHost}:${address.port}`;
  }
  return {
    host,
    port: address.port,
    baseUrl: externallyVisibleBase,
    close: async () => await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))
  };
}
