import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { basename, join, parse } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { SourceManifest, TargetResult } from '../../types/contracts.js';
import { BridgeError, ErrorCode, serializeError } from '../../security/errors.js';

export interface RemoteKeynoteWorkerOptions {
  baseUrl: string;
  token: string;
  allowInsecureLoopback?: boolean;
  timeoutMs?: number;
}

export interface RemoteKeynoteConvertOptions {
  outputDir: string;
}

export interface RemoteKeynoteDoctorResult {
  worker: 'remote';
  baseUrl: string;
  available: boolean;
  platform?: string;
  keynoteInstalled?: boolean;
  osascriptAvailable?: boolean;
  sdefAvailable?: boolean;
  version?: string;
  scriptingSaveCommand?: boolean;
  reason?: string;
}

export interface RemoteKeynoteWorkerClient {
  convert(sourcePath: string, manifest: SourceManifest, options: RemoteKeynoteConvertOptions): Promise<TargetResult>;
}

interface WorkerConversionResponse {
  native?: boolean;
  status?: 'completed' | 'completed_with_warnings' | 'failed' | 'unavailable';
  slideCount?: number;
  downloadUrl?: string;
  previewPdfUrl?: string;
  warnings?: string[];
  metadata?: Record<string, unknown>;
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
}

function loopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1' || normalized === '[::1]';
}

export function validateRemoteKeynoteWorkerUrl(rawUrl: string, allowInsecureLoopback = false): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BridgeError(ErrorCode.KEYNOTE_WORKER_UNAVAILABLE, 'Remote Keynote worker URL is invalid.');
  }
  if (url.username || url.password) {
    throw new BridgeError(ErrorCode.KEYNOTE_WORKER_UNAVAILABLE, 'Remote Keynote worker URL must not contain embedded credentials.');
  }
  const secure = url.protocol === 'https:';
  const localException = allowInsecureLoopback && url.protocol === 'http:' && loopbackHostname(url.hostname);
  if (!secure && !localException) {
    throw new BridgeError(ErrorCode.KEYNOTE_WORKER_UNAVAILABLE, 'Remote Keynote worker requires HTTPS. Plain HTTP is permitted only for an explicitly enabled loopback test/development endpoint.');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }
  url.search = '';
  url.hash = '';
  return url;
}

function workerEndpoint(base: URL, path: string): URL {
  const root = base.toString().replace(/\/+$/, '');
  return new URL(`${root}${path}`);
}

function authHeaders(token: string): Record<string, string> {
  if (!token.trim()) throw new BridgeError(ErrorCode.KEYNOTE_WORKER_UNAVAILABLE, 'Remote Keynote worker authentication token is missing.');
  return { authorization: `Bearer ${token}` };
}

function safeMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const blocked = /token|secret|authorization|credential/i;
  return Object.fromEntries(Object.entries(source).filter(([key]) => !blocked.test(key)).slice(0, 100));
}

export async function remoteKeynoteDoctor(options: RemoteKeynoteWorkerOptions): Promise<RemoteKeynoteDoctorResult> {
  const base = validateRemoteKeynoteWorkerUrl(options.baseUrl, options.allowInsecureLoopback ?? false);
  const baseUrl = base.toString().replace(/\/+$/, '');
  try {
    const response = await fetch(workerEndpoint(base, '/v1/health'), {
      headers: authHeaders(options.token),
      signal: AbortSignal.timeout(options.timeoutMs ?? 8_000)
    });
    if (!response.ok) {
      return { worker: 'remote', baseUrl, available: false, reason: `Remote worker health returned HTTP ${response.status}.` };
    }
    const payload = await response.json() as Record<string, unknown>;
    return {
      worker: 'remote',
      baseUrl,
      available: payload.available === true,
      ...(typeof payload.platform === 'string' ? { platform: payload.platform } : {}),
      ...(typeof payload.keynoteInstalled === 'boolean' ? { keynoteInstalled: payload.keynoteInstalled } : {}),
      ...(typeof payload.osascriptAvailable === 'boolean' ? { osascriptAvailable: payload.osascriptAvailable } : {}),
      ...(typeof payload.sdefAvailable === 'boolean' ? { sdefAvailable: payload.sdefAvailable } : {}),
      ...(typeof payload.version === 'string' ? { version: payload.version } : {}),
      ...(typeof payload.scriptingSaveCommand === 'boolean' ? { scriptingSaveCommand: payload.scriptingSaveCommand } : {}),
      ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {})
    };
  } catch (error) {
    return {
      worker: 'remote',
      baseUrl,
      available: false,
      reason: `Remote worker unavailable: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

export class RemoteKeynoteWorker implements RemoteKeynoteWorkerClient {
  private readonly base: URL;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(options: RemoteKeynoteWorkerOptions) {
    this.base = validateRemoteKeynoteWorkerUrl(options.baseUrl, options.allowInsecureLoopback ?? false);
    this.token = options.token;
    authHeaders(this.token);
    this.timeoutMs = options.timeoutMs ?? 180_000;
  }

  async convert(sourcePath: string, manifest: SourceManifest, options: RemoteKeynoteConvertOptions): Promise<TargetResult> {
    await mkdir(options.outputDir, { recursive: true });
    try {
      const sourceInfo = await stat(sourcePath);
      const upload = createReadStream(sourcePath);
      const webUpload = Readable.toWeb(upload) as unknown as BodyInit;
      const requestInit = {
        method: 'POST',
        headers: {
          ...authHeaders(this.token),
          'content-type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          'content-length': String(sourceInfo.size),
          'x-pb-filename': basename(sourcePath)
        },
        body: webUpload,
        duplex: 'half',
        signal: AbortSignal.timeout(this.timeoutMs)
      } as unknown as RequestInit & { duplex: 'half' };
      const response = await fetch(workerEndpoint(this.base, '/v1/convert'), requestInit);
      const responseText = await response.text();
      if (!response.ok) {
        throw new BridgeError(ErrorCode.KEYNOTE_WORKER_UNAVAILABLE, `Remote Keynote conversion request failed with HTTP ${response.status}.`, { response: responseText.slice(0, 1000) });
      }
      let payload: WorkerConversionResponse;
      try {
        payload = JSON.parse(responseText) as WorkerConversionResponse;
      } catch {
        throw new BridgeError(ErrorCode.KEYNOTE_WORKER_UNAVAILABLE, 'Remote Keynote worker returned invalid JSON.');
      }
      if (payload.native !== true || (payload.status !== 'completed' && payload.status !== 'completed_with_warnings')) {
        const message = payload.error?.message ?? 'Remote Keynote worker did not verify a native Keynote result.';
        return {
          target: 'keynote',
          status: payload.status === 'unavailable' ? 'unavailable' : 'failed',
          native: false,
          verification: payload.status === 'unavailable' ? 'unavailable' : 'live',
          warnings: Array.isArray(payload.warnings) ? payload.warnings.filter((value): value is string => typeof value === 'string') : [],
          error: { code: payload.error?.code ?? ErrorCode.KEYNOTE_WORKER_UNAVAILABLE, message, ...(payload.error?.details ? { details: payload.error.details } : {}) },
          metadata: { remote: true, workerBaseUrl: this.base.toString().replace(/\/+$/, ''), ...safeMetadata(payload.metadata) }
        };
      }
      if (typeof payload.downloadUrl !== 'string') {
        throw new BridgeError(ErrorCode.KEYNOTE_OUTPUT_MISSING, 'Remote worker verified Keynote output but did not provide an artifact download URL.');
      }
      const downloadUrl = new URL(payload.downloadUrl, this.base);
      if (downloadUrl.origin !== this.base.origin) {
        throw new BridgeError(ErrorCode.KEYNOTE_WORKER_UNAVAILABLE, 'Remote worker artifact URL changed origin; refusing to forward worker credentials.', { expectedOrigin: this.base.origin, actualOrigin: downloadUrl.origin });
      }
      const artifactResponse = await fetch(downloadUrl, {
        headers: authHeaders(this.token),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      if (!artifactResponse.ok || !artifactResponse.body) {
        throw new BridgeError(ErrorCode.KEYNOTE_OUTPUT_MISSING, `Remote Keynote artifact download failed with HTTP ${artifactResponse.status}.`);
      }
      const outputKey = join(options.outputDir, `${parse(basename(sourcePath)).name}.key`);
      const nodeBody = Readable.fromWeb(artifactResponse.body as Parameters<typeof Readable.fromWeb>[0]);
      await pipeline(nodeBody, createWriteStream(outputKey, { flags: 'wx', mode: 0o600 }));
      const artifactInfo = await stat(outputKey);
      if (!artifactInfo.isFile() || artifactInfo.size <= 0) {
        throw new BridgeError(ErrorCode.KEYNOTE_OUTPUT_MISSING, 'Downloaded remote Keynote artifact is empty or not a file.');
      }
      const slideCount = Number.isInteger(payload.slideCount) ? payload.slideCount : undefined;
      const warnings = Array.isArray(payload.warnings)
        ? payload.warnings.filter((value): value is string => typeof value === 'string')
        : [];
      let previewPdf: string | undefined;
      if (typeof payload.previewPdfUrl === 'string') {
        try {
          const previewUrl = new URL(payload.previewPdfUrl, this.base);
          if (previewUrl.origin !== this.base.origin) {
            throw new BridgeError(ErrorCode.KEYNOTE_WORKER_UNAVAILABLE, 'Remote worker preview URL changed origin; refusing to forward worker credentials.');
          }
          const previewResponse = await fetch(previewUrl, {
            headers: authHeaders(this.token),
            signal: AbortSignal.timeout(this.timeoutMs)
          });
          if (!previewResponse.ok || !previewResponse.body) throw new Error(`HTTP ${previewResponse.status}`);
          previewPdf = join(options.outputDir, `${parse(basename(sourcePath)).name}.pdf`);
          const previewBody = Readable.fromWeb(previewResponse.body as Parameters<typeof Readable.fromWeb>[0]);
          await pipeline(previewBody, createWriteStream(previewPdf, { flags: 'wx', mode: 0o600 }));
          const previewInfo = await stat(previewPdf);
          if (!previewInfo.isFile() || previewInfo.size <= 0) throw new Error('downloaded preview is empty');
        } catch (error) {
          previewPdf = undefined;
          warnings.push(`Remote Keynote PDF preview download failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (slideCount !== undefined && slideCount !== manifest.slideCount) {
        warnings.push(`Slide count changed: source=${manifest.slideCount}, target=${slideCount}`);
      }
      return {
        target: 'keynote',
        status: warnings.length ? 'completed_with_warnings' : 'completed',
        native: true,
        verification: 'live',
        ...(slideCount !== undefined ? { slideCount } : {}),
        artifact: outputKey,
        warnings,
        metadata: {
          remote: true,
          workerBaseUrl: this.base.toString().replace(/\/+$/, ''),
          artifactBytes: artifactInfo.size,
          ...(previewPdf ? { previewPdf } : {}),
          ...safeMetadata(payload.metadata)
        }
      };
    } catch (error) {
      return {
        target: 'keynote',
        status: 'failed',
        native: false,
        verification: 'live',
        warnings: [],
        error: serializeError(error),
        metadata: { remote: true, workerBaseUrl: this.base.toString().replace(/\/+$/, '') }
      };
    }
  }
}

export class UnconfiguredRemoteKeynoteWorker implements RemoteKeynoteWorkerClient {
  async convert(): Promise<TargetResult> {
    return {
      target: 'keynote',
      status: 'unavailable',
      native: false,
      verification: 'unavailable',
      warnings: [],
      error: serializeError(new BridgeError(ErrorCode.KEYNOTE_WORKER_UNAVAILABLE, 'Remote Keynote worker is not configured.')),
      metadata: {}
    };
  }
}
