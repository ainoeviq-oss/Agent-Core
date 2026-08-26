#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
const DEFAULT_COMPATIBILITY_DATE = '2026-08-27';

function normalizeHttpsOrigin(raw, errorCode) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error(errorCode);
  }
  const valid = url.protocol === 'https:'
    && !url.username
    && !url.password
    && !url.port
    && (url.pathname === '/' || url.pathname === '')
    && !url.search
    && !url.hash;
  if (!valid) throw new Error(errorCode);
  return url.origin;
}

export function validateBackendUrl(raw) {
  const origin = normalizeHttpsOrigin(raw, 'STABLE_GATEWAY_BACKEND_URL_INVALID');
  if (!new URL(origin).hostname.endsWith('.app.github.dev')) {
    throw new Error('STABLE_GATEWAY_BACKEND_URL_INVALID');
  }
  return origin;
}

export function validateStableBaseUrl(raw) {
  return normalizeHttpsOrigin(raw, 'STABLE_GATEWAY_BASE_URL_INVALID');
}

function requireNonEmpty(value, code) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

async function readCloudflareResult(response, code) {
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(code);
  }
  if (!response.ok || body?.success !== true) throw new Error(code);
  return body;
}

export async function resolveCloudflareAccountId({
  accountId,
  apiToken,
  fetchImpl = fetch,
}) {
  const explicit = String(accountId ?? '').trim();
  if (explicit) return explicit;

  const safeToken = requireNonEmpty(apiToken, 'CLOUDFLARE_API_TOKEN_REQUIRED');
  const response = await fetchImpl(`${CLOUDFLARE_API_BASE}/accounts`, {
    method: 'GET',
    headers: { authorization: `Bearer ${safeToken}` },
  });
  const body = await readCloudflareResult(response, 'CLOUDFLARE_ACCOUNT_ID_DISCOVERY_FAILED');
  const accounts = Array.isArray(body?.result)
    ? body.result.filter((entry) => typeof entry?.id === 'string' && entry.id.trim())
    : [];
  const totalCount = Number(body?.result_info?.total_count ?? accounts.length);

  if (accounts.length === 0 || totalCount === 0) throw new Error('CLOUDFLARE_ACCOUNT_ID_NOT_FOUND');
  if (accounts.length !== 1 || totalCount !== 1) throw new Error('CLOUDFLARE_ACCOUNT_ID_AMBIGUOUS');
  return accounts[0].id.trim();
}

export async function updateBackendSecret({
  accountId,
  apiToken,
  workerName,
  backendUrl,
  fetchImpl = fetch,
}) {
  const safeAccountId = requireNonEmpty(accountId, 'CLOUDFLARE_ACCOUNT_ID_REQUIRED');
  const safeToken = requireNonEmpty(apiToken, 'CLOUDFLARE_API_TOKEN_REQUIRED');
  const safeWorkerName = requireNonEmpty(workerName, 'CLOUDFLARE_WORKER_NAME_REQUIRED');
  const safeBackend = validateBackendUrl(backendUrl);
  const endpoint = `${CLOUDFLARE_API_BASE}/accounts/${encodeURIComponent(safeAccountId)}/workers/scripts/${encodeURIComponent(safeWorkerName)}/secrets`;
  const response = await fetchImpl(endpoint, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${safeToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      name: 'BACKEND_URL',
      text: safeBackend,
      type: 'secret_text',
    }),
  });
  await readCloudflareResult(response, 'CLOUDFLARE_BACKEND_SECRET_UPDATE_FAILED');
}

export async function deployWorkerSource({
  accountId,
  apiToken,
  workerName,
  workerSource,
  compatibilityDate = DEFAULT_COMPATIBILITY_DATE,
  fetchImpl = fetch,
}) {
  const safeAccountId = requireNonEmpty(accountId, 'CLOUDFLARE_ACCOUNT_ID_REQUIRED');
  const safeToken = requireNonEmpty(apiToken, 'CLOUDFLARE_API_TOKEN_REQUIRED');
  const safeWorkerName = requireNonEmpty(workerName, 'CLOUDFLARE_WORKER_NAME_REQUIRED');
  const source = requireNonEmpty(workerSource, 'CLOUDFLARE_WORKER_SOURCE_REQUIRED');
  const endpoint = `${CLOUDFLARE_API_BASE}/accounts/${encodeURIComponent(safeAccountId)}/workers/scripts/${encodeURIComponent(safeWorkerName)}`;

  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify({
    main_module: 'worker.mjs',
    compatibility_date: compatibilityDate,
  })], { type: 'application/json' }), 'metadata');
  form.append('worker.mjs', new Blob([source], { type: 'application/javascript+module' }), 'worker.mjs');

  const response = await fetchImpl(endpoint, {
    method: 'PUT',
    headers: { authorization: `Bearer ${safeToken}` },
    body: form,
  });
  await readCloudflareResult(response, 'CLOUDFLARE_WORKER_DEPLOY_FAILED');
}

function healthPayloadOk(value, expectedVersion) {
  return value?.status === 'ok'
    && value?.memory?.healthy === true
    && value?.continuity?.healthy === true
    && value?.execution?.healthy === true
    && (!expectedVersion || value?.version === expectedVersion);
}

async function requireJson(response, code) {
  if (!response.ok) throw new Error(code);
  try {
    return await response.json();
  } catch {
    throw new Error(code);
  }
}

export async function verifyStableGateway({
  stableBaseUrl,
  backendUrl,
  expectedVersion = '',
  fetchImpl = fetch,
}) {
  const stable = validateStableBaseUrl(stableBaseUrl);
  const backend = validateBackendUrl(backendUrl);
  const expectedBackendHost = new URL(backend).hostname;

  const healthResponse = await fetchImpl(`${stable}/health`, { redirect: 'manual' });
  const health = await requireJson(healthResponse, 'STABLE_GATEWAY_HEALTH_FAILED');
  if (!healthPayloadOk(health, expectedVersion)) throw new Error('STABLE_GATEWAY_HEALTH_FAILED');
  if (healthResponse.headers.get('x-agent-core-backend-host') !== expectedBackendHost) {
    throw new Error('STABLE_GATEWAY_BACKEND_CONFIRMATION_FAILED');
  }

  const oauth = await requireJson(
    await fetchImpl(`${stable}/.well-known/oauth-authorization-server`, { redirect: 'manual' }),
    'STABLE_GATEWAY_OAUTH_METADATA_FAILED',
  );
  if (oauth?.issuer !== stable
    || oauth?.authorization_endpoint !== `${stable}/oauth/authorize`
    || oauth?.token_endpoint !== `${stable}/oauth/token`
    || oauth?.registration_endpoint !== `${stable}/oauth/register`) {
    throw new Error('STABLE_GATEWAY_OAUTH_METADATA_FAILED');
  }

  const resource = await requireJson(
    await fetchImpl(`${stable}/.well-known/oauth-protected-resource/mcp`, { redirect: 'manual' }),
    'STABLE_GATEWAY_RESOURCE_METADATA_FAILED',
  );
  if (resource?.resource !== `${stable}/mcp`
    || !Array.isArray(resource?.authorization_servers)
    || resource.authorization_servers.length !== 1
    || resource.authorization_servers[0] !== stable) {
    throw new Error('STABLE_GATEWAY_RESOURCE_METADATA_FAILED');
  }

  const mcp = await fetchImpl(`${stable}/mcp`, { redirect: 'manual' });
  const challenge = mcp.headers.get('www-authenticate') ?? '';
  if (mcp.status !== 401
    || !challenge.includes(`${stable}/.well-known/oauth-protected-resource/mcp`)
    || !challenge.includes('scope="mcp:tools"')) {
    throw new Error('STABLE_GATEWAY_MCP_CHALLENGE_FAILED');
  }
}

async function runCli() {
  const [command, backendArg, versionArg, stableArg, workerArg, workerSourceArg] = process.argv.slice(2);
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = await resolveCloudflareAccountId({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken,
  });
  const workerName = workerArg || process.env.AGENT_CORE_CLOUDFLARE_WORKER_NAME || 'agent-core-gateway';
  const stableBaseUrl = stableArg || process.env.AGENT_CORE_STABLE_GATEWAY_BASE_URL;
  const backendUrl = backendArg;
  const expectedVersion = versionArg || '';

  if (command === 'update') {
    await updateBackendSecret({ accountId, apiToken, workerName, backendUrl });
    await verifyStableGateway({ stableBaseUrl, backendUrl, expectedVersion });
    process.stdout.write(`Stable gateway backend verified: ${validateStableBaseUrl(stableBaseUrl)}\n`);
    return;
  }

  if (command === 'deploy') {
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const defaultWorkerSource = path.resolve(scriptDir, '../../cloudflare/agent-core-gateway/worker.mjs');
    const workerSourcePath = workerSourceArg || defaultWorkerSource;
    const workerSource = await readFile(workerSourcePath, 'utf8');
    await deployWorkerSource({ accountId, apiToken, workerName, workerSource });
    await updateBackendSecret({ accountId, apiToken, workerName, backendUrl });
    await verifyStableGateway({ stableBaseUrl, backendUrl, expectedVersion });
    process.stdout.write(`Stable gateway deployed and verified: ${validateStableBaseUrl(stableBaseUrl)}\n`);
    return;
  }

  throw new Error('STABLE_GATEWAY_COMMAND_INVALID');
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  runCli().catch((error) => {
    const code = error instanceof Error ? error.message : 'STABLE_GATEWAY_UNKNOWN_ERROR';
    process.stderr.write(`[agent-core-codespace] ERROR: ${code}\n`);
    process.exitCode = 1;
  });
}
