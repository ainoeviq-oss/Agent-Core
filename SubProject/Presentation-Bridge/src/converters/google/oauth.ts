import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BridgeConfig } from '../../config/index.js';
import { BridgeError, ErrorCode } from '../../security/errors.js';
import { GOOGLE_SCOPES } from './constants.js';

interface OAuthClientDefinition {
  client_id: string;
  client_secret: string;
  auth_uri: string;
  token_uri: string;
  redirect_uris?: string[];
}

interface OAuthClientFile {
  installed?: OAuthClientDefinition;
  web?: OAuthClientDefinition;
}

export interface StoredGoogleToken {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  scope?: string;
  expires_at: number;
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function readClient(config: BridgeConfig): Promise<OAuthClientDefinition> {
  if (!(await exists(config.googleCredentialsPath))) {
    throw new BridgeError(ErrorCode.GOOGLE_AUTH_REQUIRED, 'Google OAuth desktop client file is missing', { expectedPath: config.googleCredentialsPath });
  }
  const parsed = JSON.parse(await readFile(config.googleCredentialsPath, 'utf8')) as OAuthClientFile;
  const client = parsed.installed ?? parsed.web;
  if (!client?.client_id || !client.client_secret || !client.auth_uri || !client.token_uri) {
    throw new BridgeError(ErrorCode.GOOGLE_AUTH_REQUIRED, 'Google OAuth client JSON is missing required desktop/web client fields.');
  }
  return client;
}

function base64url(data: Buffer): string {
  return data.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function openBrowser(url: string): void {
  const spec = process.platform === 'win32'
    ? { command: 'cmd.exe', args: ['/c', 'start', '', url] }
    : process.platform === 'darwin'
      ? { command: '/usr/bin/open', args: [url] }
      : { command: 'xdg-open', args: [url] };
  const child = spawn(spec.command, spec.args, { detached: true, stdio: 'ignore' });
  child.unref();
}

async function exchangeToken(client: OAuthClientDefinition, params: URLSearchParams): Promise<StoredGoogleToken> {
  const response = await fetch(client.token_uri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params
  });
  const text = await response.text();
  if (!response.ok) throw new BridgeError(ErrorCode.GOOGLE_AUTH_REQUIRED, `Google OAuth token exchange failed: HTTP ${response.status}`, { response: text.slice(0, 500) });
  const json = JSON.parse(text) as { access_token?: string; refresh_token?: string; expires_in?: number; token_type?: string; scope?: string };
  if (!json.access_token) throw new BridgeError(ErrorCode.GOOGLE_AUTH_REQUIRED, 'Google OAuth token response did not contain access_token.');
  return {
    access_token: json.access_token,
    ...(json.refresh_token ? { refresh_token: json.refresh_token } : {}),
    token_type: json.token_type ?? 'Bearer',
    ...(json.scope ? { scope: json.scope } : {}),
    expires_at: Date.now() + (json.expires_in ?? 3600) * 1000
  };
}

async function saveToken(path: string, token: StoredGoogleToken): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(token, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') await chmod(path, 0o600).catch(() => undefined);
}

export async function authorizeGoogle(config: BridgeConfig): Promise<void> {
  const client = await readClient(config);
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(randomBytes(24));

  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/oauth2callback') { res.writeHead(404).end('Not found'); return; }
      if (url.searchParams.get('state') !== state) throw new Error('OAuth state mismatch');
      const error = url.searchParams.get('error');
      if (error) throw new Error(`OAuth authorization failed: ${error}`);
      const code = url.searchParams.get('code');
      if (!code) throw new Error('OAuth callback did not contain code');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><title>Presentation Bridge</title><body style="font-family:system-ui;padding:40px"><h1>Authorization received</h1><p>You can return to Presentation Bridge.</p></body>');
      resolveCode(code);
    } catch (error) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Authorization failed. Return to the terminal.');
      rejectCode(error instanceof Error ? error : new Error(String(error)));
    }
  });
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', () => resolve()).once('error', reject));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not bind OAuth loopback server');
  const redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
  const authUrl = new URL(client.auth_uri);
  authUrl.search = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256'
  }).toString();
  console.log(`Open this URL if your browser does not launch automatically:\n${authUrl.toString()}`);
  openBrowser(authUrl.toString());

  const timeout = setTimeout(() => rejectCode(new Error('OAuth authorization timed out after 5 minutes')), 300_000);
  try {
    const code = await codePromise;
    const token = await exchangeToken(client, new URLSearchParams({
      code,
      client_id: client.client_id,
      client_secret: client.client_secret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier
    }));
    await saveToken(config.googleTokenPath, token);
  } finally {
    clearTimeout(timeout);
    server.close();
  }
}

export async function getGoogleAccessToken(config: BridgeConfig): Promise<string> {
  const client = await readClient(config);
  if (!(await exists(config.googleTokenPath))) throw new BridgeError(ErrorCode.GOOGLE_AUTH_REQUIRED, 'Google OAuth token is not configured. Run `presentation-bridge google auth`.');
  const token = JSON.parse(await readFile(config.googleTokenPath, 'utf8')) as StoredGoogleToken;
  if (token.access_token && token.expires_at > Date.now() + 60_000) return token.access_token;
  if (!token.refresh_token) throw new BridgeError(ErrorCode.GOOGLE_AUTH_REQUIRED, 'Google token is expired and has no refresh token. Run Google authorization again.');
  const refreshed = await exchangeToken(client, new URLSearchParams({
    client_id: client.client_id,
    client_secret: client.client_secret,
    refresh_token: token.refresh_token,
    grant_type: 'refresh_token'
  }));
  const merged: StoredGoogleToken = { ...refreshed, refresh_token: token.refresh_token };
  await saveToken(config.googleTokenPath, merged);
  return merged.access_token;
}

export async function googleCredentialStatus(config: BridgeConfig): Promise<{ credentialsPresent: boolean; tokenPresent: boolean }> {
  return { credentialsPresent: await exists(config.googleCredentialsPath), tokenPresent: await exists(config.googleTokenPath) };
}
