#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
const DEFAULT_WORKER_NAME = 'codespace-control-plane';
const DEFAULT_COMPATIBILITY_DATE = '2026-08-28';

function required(value, code) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

async function cloudflareResult(response, code) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(code);
  }
  if (!response.ok || payload?.success !== true) throw new Error(code);
  return payload;
}

export async function resolveAccountId({ accountId, apiToken, fetchImpl = fetch }) {
  const explicit = String(accountId ?? '').trim();
  if (explicit) return explicit;
  const token = required(apiToken, 'CODESPACE_CLOUDFLARE_API_TOKEN_REQUIRED');
  const response = await fetchImpl(`${CLOUDFLARE_API_BASE}/accounts`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await cloudflareResult(response, 'CODESPACE_CLOUDFLARE_ACCOUNT_DISCOVERY_FAILED');
  const accounts = Array.isArray(body.result)
    ? body.result.filter((entry) => typeof entry?.id === 'string' && entry.id.trim())
    : [];
  if (accounts.length !== 1) throw new Error('CODESPACE_CLOUDFLARE_ACCOUNT_AMBIGUOUS');
  return accounts[0].id.trim();
}

export async function deployControlPlaneWorker({
  accountId,
  apiToken,
  runtimeKey,
  workerName = DEFAULT_WORKER_NAME,
  workerSource,
  compatibilityDate = DEFAULT_COMPATIBILITY_DATE,
  fetchImpl = fetch,
}) {
  const account = required(accountId, 'CODESPACE_CLOUDFLARE_ACCOUNT_ID_REQUIRED');
  const token = required(apiToken, 'CODESPACE_CLOUDFLARE_API_TOKEN_REQUIRED');
  const secret = required(runtimeKey, 'CODESPACE_OPENAI_TUNNEL_RUNTIME_KEY_REQUIRED');
  const name = required(workerName, 'CODESPACE_CLOUDFLARE_WORKER_NAME_REQUIRED');
  const source = required(workerSource, 'CODESPACE_CONTROL_PLANE_WORKER_SOURCE_REQUIRED');
  const endpoint = `${CLOUDFLARE_API_BASE}/accounts/${encodeURIComponent(account)}/workers/scripts/${encodeURIComponent(name)}`;

  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify({
    main_module: 'worker.mjs',
    compatibility_date: compatibilityDate,
    compatibility_flags: ['nodejs_compat'],
  })], { type: 'application/json' }), 'metadata');
  form.append('worker.mjs', new Blob([source], { type: 'application/javascript+module' }), 'worker.mjs');

  await cloudflareResult(await fetchImpl(endpoint, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  }), 'CODESPACE_CONTROL_PLANE_DEPLOY_FAILED');

  await cloudflareResult(await fetchImpl(`${endpoint}/secrets`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      name: 'OPENAI_TUNNEL_RUNTIME_KEY',
      text: secret,
      type: 'secret_text',
    }),
  }), 'CODESPACE_CONTROL_PLANE_SECRET_UPDATE_FAILED');
}

export async function verifyControlPlaneHealth({ baseUrl, fetchImpl = fetch, attempts = 20, delayMs = 500 }) {
  const base = new URL(required(baseUrl, 'CODESPACE_CONTROL_PLANE_BASE_URL_REQUIRED'));
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new Error('CODESPACE_CONTROL_PLANE_BASE_URL_INVALID');
  }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(new URL('/health', base), { redirect: 'manual' });
      if (response.ok) {
        const payload = await response.json();
        if (payload?.status === 'ok' && payload?.service === 'codespace-control-plane' && payload?.runtime_secret_configured === true) {
          return;
        }
      }
    } catch {}
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error('CODESPACE_CONTROL_PLANE_HEALTH_FAILED');
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const bootstrap = JSON.parse(await readFile(path.join(root, 'config', 'bootstrap.defaults.json'), 'utf8'));
  const workerSource = await readFile(path.join(root, 'control-plane', 'worker.mjs'), 'utf8');
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const runtimeKey = process.env.CODESPACE_OPENAI_TUNNEL_RUNTIME_KEY;
  const accountId = await resolveAccountId({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken,
  });
  await deployControlPlaneWorker({
    accountId,
    apiToken,
    runtimeKey,
    workerName: process.env.CODESPACE_CLOUDFLARE_WORKER_NAME || DEFAULT_WORKER_NAME,
    workerSource,
  });
  await verifyControlPlaneHealth({ baseUrl: bootstrap.controlPlaneBaseUrl });
  process.stdout.write(`codespace control-plane deployed and verified: ${bootstrap.controlPlaneBaseUrl}\n`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    const code = error instanceof Error ? error.message : 'CODESPACE_CONTROL_PLANE_DEPLOY_UNKNOWN_ERROR';
    process.stderr.write(`[codespace] ERROR: ${code}\n`);
    process.exitCode = 1;
  });
}
