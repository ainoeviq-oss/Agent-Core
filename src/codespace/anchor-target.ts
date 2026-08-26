import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ANCHOR_LOCAL_BACKEND_PORT, ANCHOR_PUBLIC_BASE_URL } from './anchor-config.js';
import type { AnchorProxyTarget } from './anchor-proxy.js';

export interface AnchorBackendTarget extends AnchorProxyTarget {
  codespaceName: string | null;
  verified: true;
  verifiedAt: string;
}

export interface VerifyBackendOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}

export function anchorTargetStatePath(home = process.env.AGENT_CORE_CODESPACE_HOME ?? '/workspaces/.agent-core-codespace'): string {
  return path.join(home, 'anchor', 'backend.json');
}

export function localAnchorTarget(): AnchorBackendTarget {
  const baseUrl = `http://127.0.0.1:${ANCHOR_LOCAL_BACKEND_PORT}`;
  return {
    mode: 'local',
    baseUrl,
    advertisedBaseUrl: baseUrl,
    codespaceName: null,
    verified: true,
    verifiedAt: 'local-fallback',
  };
}

function isTarget(value: unknown): value is AnchorBackendTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const target = value as Record<string, unknown>;
  return (target.mode === 'local' || target.mode === 'remote')
    && typeof target.baseUrl === 'string'
    && (target.advertisedBaseUrl === undefined || typeof target.advertisedBaseUrl === 'string')
    && (target.codespaceName === null || typeof target.codespaceName === 'string')
    && target.verified === true
    && typeof target.verifiedAt === 'string';
}

export async function readAnchorTarget(statePath = anchorTargetStatePath()): Promise<AnchorBackendTarget> {
  try {
    const parsed = JSON.parse(await readFile(statePath, 'utf8')) as unknown;
    return isTarget(parsed) ? parsed : localAnchorTarget();
  } catch {
    return localAnchorTarget();
  }
}

export async function writeAnchorTargetAtomic(target: AnchorBackendTarget, statePath = anchorTargetStatePath()): Promise<void> {
  const directory = path.dirname(statePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${statePath}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(target, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, statePath);
  await chmod(statePath, 0o600);
}

function parseCodespaceBackendUrl(value: string): { url: URL; codespaceName: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('ANCHOR_BACKEND_URL_INVALID');
  }
  const anchorHost = new URL(ANCHOR_PUBLIC_BASE_URL).hostname;
  if (url.protocol !== 'https:'
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname !== '/'
    || !url.hostname.endsWith('.app.github.dev')
    || url.hostname === anchorHost) {
    throw new Error('ANCHOR_BACKEND_URL_INVALID');
  }
  const label = url.hostname.slice(0, -'.app.github.dev'.length);
  const codespaceName = label.replace(/-\d+$/, '');
  if (!codespaceName) throw new Error('ANCHOR_BACKEND_URL_INVALID');
  return { url, codespaceName };
}

async function fetchWithTimeout(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<Response> {
  return fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
}

export async function verifyRemoteBackend(baseUrl: string, options: VerifyBackendOptions = {}): Promise<AnchorBackendTarget> {
  const parsed = parseCodespaceBackendUrl(baseUrl);
  const normalizedBase = parsed.url.toString().replace(/\/$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5000;

  let health: Response;
  try {
    health = await fetchWithTimeout(fetchImpl, `${normalizedBase}/health`, timeoutMs);
  } catch {
    throw new Error('ANCHOR_BACKEND_HEALTH_UNREACHABLE');
  }
  if (!health.ok) throw new Error('ANCHOR_BACKEND_HEALTH_INVALID');
  let healthBody: Record<string, unknown>;
  try {
    healthBody = await health.json() as Record<string, unknown>;
  } catch {
    throw new Error('ANCHOR_BACKEND_HEALTH_INVALID');
  }
  const memory = healthBody.memory as Record<string, unknown> | undefined;
  const continuity = healthBody.continuity as Record<string, unknown> | undefined;
  const execution = healthBody.execution as Record<string, unknown> | undefined;
  if (healthBody.status !== 'ok'
    || healthBody.service !== 'agent-core'
    || memory?.healthy !== true
    || continuity?.healthy !== true
    || execution?.healthy !== true) {
    throw new Error('ANCHOR_BACKEND_HEALTH_INVALID');
  }

  let oauth: Response;
  try {
    oauth = await fetchWithTimeout(fetchImpl, `${normalizedBase}/.well-known/oauth-authorization-server`, timeoutMs);
  } catch {
    throw new Error('ANCHOR_BACKEND_OAUTH_UNREACHABLE');
  }
  if (!oauth.ok) throw new Error('ANCHOR_BACKEND_OAUTH_INVALID');
  let oauthBody: Record<string, unknown>;
  try {
    oauthBody = await oauth.json() as Record<string, unknown>;
  } catch {
    throw new Error('ANCHOR_BACKEND_OAUTH_INVALID');
  }
  if (typeof oauthBody.issuer !== 'string'
    || typeof oauthBody.authorization_endpoint !== 'string'
    || typeof oauthBody.token_endpoint !== 'string'
    || typeof oauthBody.registration_endpoint !== 'string') {
    throw new Error('ANCHOR_BACKEND_OAUTH_INVALID');
  }

  let mcp: Response;
  try {
    mcp = await fetchWithTimeout(fetchImpl, `${normalizedBase}/mcp`, timeoutMs);
  } catch {
    throw new Error('ANCHOR_BACKEND_MCP_UNREACHABLE');
  }
  if (mcp.status !== 401) throw new Error('ANCHOR_BACKEND_MCP_INVALID');

  return {
    mode: 'remote',
    baseUrl: normalizedBase,
    advertisedBaseUrl: oauthBody.issuer,
    codespaceName: parsed.codespaceName,
    verified: true,
    verifiedAt: (options.now ?? (() => new Date()))().toISOString(),
  };
}

export async function verifyAndWriteRemoteBackend(
  baseUrl: string,
  statePath = anchorTargetStatePath(),
  options: VerifyBackendOptions = {},
): Promise<AnchorBackendTarget> {
  const verified = await verifyRemoteBackend(baseUrl, options);
  await writeAnchorTargetAtomic(verified, statePath);
  return verified;
}

async function cli(): Promise<void> {
  const value = process.argv[2] ?? '';
  const statePath = anchorTargetStatePath();
  if (value === 'local') {
    const local = { ...localAnchorTarget(), verifiedAt: new Date().toISOString() };
    await writeAnchorTargetAtomic(local, statePath);
    process.stdout.write(`${JSON.stringify({ ok: true, mode: local.mode, baseUrl: local.baseUrl })}\n`);
    return;
  }
  if (!value) throw new Error('usage: anchor-target <local|https://CODESPACE-PORT.app.github.dev>');
  const verified = await verifyAndWriteRemoteBackend(value, statePath);
  process.stdout.write(`${JSON.stringify({ ok: true, mode: verified.mode, baseUrl: verified.baseUrl, codespaceName: verified.codespaceName, verifiedAt: verified.verifiedAt })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'anchor_target_failed';
    process.stderr.write(`[agent-core-anchor] ERROR: ${message}\n`);
    process.exitCode = 1;
  });
}
