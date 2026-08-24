import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { FileKeyStore } from '../src/auth/key-store.js';
import { createHttpHandler } from '../src/http/app.js';
import { FileAuditLogger } from '../src/logging/audit-log.js';
import { createMcpHttpHandler } from '../src/mcp/handler.js';
import { FileOAuthStore } from '../src/oauth/store.js';
import { OAuthService } from '../src/oauth/service.js';
import { createRuntimeServices } from '../src/runtime/services.js';

const roots: string[] = [];
const servers: Server[] = [];

function pkce(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-core-oauth-'));
  roots.push(root);
  const dataDir = path.join(root, 'data');
  const keyStore = new FileKeyStore(dataDir);
  const oauthStore = new FileOAuthStore(dataDir);
  const oauthService = new OAuthService(keyStore, oauthStore);
  const app = createHttpHandler({
    keyStore,
    oauthService,
    auditLogger: new FileAuditLogger(path.join(root, 'logs')),
    mcpHandler: createMcpHttpHandler(createRuntimeServices([root])),
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    keyStore,
    oauthStore,
    externalBase: 'https://agent-core-tunnel.example',
  };
}

const forwarded = {
  'x-forwarded-proto': 'https',
  'x-forwarded-host': 'agent-core-tunnel.example',
};

async function registerClient(baseUrl: string) {
  const response = await fetch(`${baseUrl}/oauth/register`, {
    method: 'POST',
    headers: { ...forwarded, 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'ChatGPT',
      redirect_uris: ['https://chatgpt.com/connector/oauth/test'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
    }),
  });
  expect(response.status).toBe(201);
  return await response.json() as Record<string, any>;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Agent Core OAuth bridge', () => {
  it('advertises protected-resource and OAuth metadata with DCR and PKCE', async () => {
    const { baseUrl, externalBase } = await setup();
    const protectedResource = await fetch(
      `${baseUrl}/.well-known/oauth-protected-resource/mcp`,
      { headers: forwarded },
    );
    expect(protectedResource.status).toBe(200);
    expect(await protectedResource.json()).toMatchObject({
      resource: `${externalBase}/mcp`,
      authorization_servers: [externalBase],
      scopes_supported: ['mcp:tools'],
    });
    const metadata = await fetch(
      `${baseUrl}/.well-known/oauth-authorization-server`,
      { headers: forwarded },
    );
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({
      issuer: externalBase,
      authorization_endpoint: `${externalBase}/oauth/authorize`,
      token_endpoint: `${externalBase}/oauth/token`,
      registration_endpoint: `${externalBase}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      scopes_supported: ['mcp:tools', 'offline_access'],
    });
  });

  it('registers a confidential OAuth client without storing its raw secret', async () => {
    const { baseUrl, oauthStore } = await setup();
    const client = await registerClient(baseUrl);
    expect(client.client_id).toMatch(/^agent_core_client_/);
    expect(client.client_secret).toMatch(/^agent_core_secret_/);
    expect(client.token_endpoint_auth_method).toBe('client_secret_post');

    const stored = await readFile(oauthStore.filePath, 'utf8');
    expect(stored).toContain(client.client_id);
    expect(stored).not.toContain(client.client_secret);
  });

  it('exchanges an API-key-approved PKCE code for MCP OAuth tokens', async () => {
    const { baseUrl, keyStore, oauthStore, externalBase } = await setup();
    const key = await keyStore.create('chatgpt-oauth');
    const client = await registerClient(baseUrl);
    const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~pkce';
    const redirectUri = client.redirect_uris[0] as string;
    const authorizeParams = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: redirectUri,
      state: 'state-123',
      code_challenge: pkce(verifier),
      code_challenge_method: 'S256',
      resource: `${externalBase}/mcp`,
      scope: 'mcp:tools offline_access',
    });

    const form = await fetch(`${baseUrl}/oauth/authorize?${authorizeParams}`, {
      headers: forwarded,
    });
    expect(form.status).toBe(200);
    expect(await form.text()).toContain('Agent Core API key');

    const approved = await fetch(`${baseUrl}/oauth/authorize`, {
      method: 'POST',
      redirect: 'manual',
      headers: { ...forwarded, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...Object.fromEntries(authorizeParams), api_key: key.key }),
    });
    expect(approved.status).toBe(302);
    const callback = new URL(approved.headers.get('location')!);
    expect(callback.origin + callback.pathname).toBe(redirectUri);
    expect(callback.searchParams.get('state')).toBe('state-123');
    const code = callback.searchParams.get('code');
    expect(code).toMatch(/^agent_core_code_/);
    const tokenResponse = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { ...forwarded, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        client_secret: client.client_secret,
        code: code!,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource: `${externalBase}/mcp`,
      }),
    });
    expect(tokenResponse.status).toBe(200);
    const tokens = await tokenResponse.json() as Record<string, any>;
    expect(tokens.access_token).toMatch(/^agent_core_oauth_/);
    expect(tokens.refresh_token).toMatch(/^agent_core_refresh_/);
    expect(tokens.scope).toContain('mcp:tools');

    const initialize = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        ...forwarded,
        authorization: `Bearer ${tokens.access_token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: {
          protocolVersion: '2025-11-25', capabilities: {},
          clientInfo: { name: 'chatgpt', version: '1.0' },
        },
      }),
    });
    expect(initialize.status).toBe(200);

    const statusResponse = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        ...forwarded,
        authorization: `Bearer ${tokens.access_token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'agent_core_status', arguments: {} },
      }),
    });
    const statusJson = await statusResponse.json() as Record<string, any>;
    expect(statusJson.result.structuredContent).toMatchObject({
      authentication: 'oauth2',
      key: { id: key.metadata.id, name: 'chatgpt-oauth' },
    });

    const refreshed = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { ...forwarded, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: client.client_id,
        client_secret: client.client_secret,
        refresh_token: tokens.refresh_token,
        resource: `${externalBase}/mcp`,
      }),
    });
    expect(refreshed.status).toBe(200);
    const refreshTokens = await refreshed.json() as Record<string, any>;
    expect(refreshTokens.access_token).toMatch(/^agent_core_oauth_/);
    expect(refreshTokens.refresh_token).toMatch(/^agent_core_refresh_/);
    expect(refreshTokens.refresh_token).not.toBe(tokens.refresh_token);
    const stored = await readFile(oauthStore.filePath, 'utf8');
    expect(stored).not.toContain(key.key);
    expect(stored).not.toContain(client.client_secret);
    expect(stored).not.toContain(tokens.access_token);
    expect(stored).not.toContain(tokens.refresh_token);
  });

  it('returns an OAuth discovery challenge for invalid MCP tokens', async () => {
    const { baseUrl, externalBase } = await setup();
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        ...forwarded,
        authorization: 'Bearer agent_core_oauth_invalid',
      },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain(
      `resource_metadata="${externalBase}/.well-known/oauth-protected-resource/mcp"`,
    );
    expect(response.headers.get('www-authenticate')).toContain('scope="mcp:tools"');
  });
});

describe('Agent Core OAuth authorization-state reset', () => {
  it('imports legacy client registrations, clears grants, and preserves custom Agent Core keys', async () => {
    const { baseUrl, keyStore, oauthStore, externalBase } = await setup();
    const key = await keyStore.create('custom-agent-core-local');
    const existingClient = await oauthStore.registerClient({
      clientName: 'Existing Client',
      redirectUris: ['https://chatgpt.com/connector/oauth/existing'],
      grantTypes: ['authorization_code', 'refresh_token'],
      responseTypes: ['code'],
      tokenEndpointAuthMethod: 'client_secret_post',
    });
    const oldTokens = await oauthStore.issueTokens({
      clientId: existingClient.client_id,
      resource: `${externalBase}/mcp`,
      scopes: ['mcp:tools'],
      keyId: key.metadata.id,
      keyName: key.metadata.name,
    });

    const legacyDir = path.join(path.dirname(path.dirname(oauthStore.filePath)), 'data-current');
    const legacyStore = new FileOAuthStore(legacyDir);
    const legacyClient = await legacyStore.registerClient({
      clientName: 'ChatGPT',
      redirectUris: ['https://chatgpt.com/connector/oauth/QTOb4VcHdCsW'],
      grantTypes: ['authorization_code', 'refresh_token'],
      responseTypes: ['code'],
      tokenEndpointAuthMethod: 'client_secret_post',
    });
    const authorize = new URLSearchParams({
      response_type: 'code',
      client_id: legacyClient.client_id,
      redirect_uri: legacyClient.redirect_uris[0]!,
      state: 'reset-state',
      code_challenge: pkce('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~reset'),
      code_challenge_method: 'S256',
      resource: `${externalBase}/mcp`,
      scope: 'mcp:tools',
    });

    expect((await fetch(`${baseUrl}/oauth/authorize?${authorize}`, { headers: forwarded })).status).toBe(400);
    const reset = await oauthStore.resetAuthorizationState({ importClientStores: [legacyStore] });
    expect(reset.backupPath).toBeTruthy();
    expect(reset.clientsImported).toBe(1);
    expect(await oauthStore.getClient(existingClient.client_id)).not.toBeNull();
    expect(await oauthStore.getClient(legacyClient.client_id)).not.toBeNull();
    expect(await oauthStore.verifyAccessToken(oldTokens.accessToken)).toBeNull();
    expect((await keyStore.verify(key.key))?.id).toBe(key.metadata.id);

    const after = await fetch(`${baseUrl}/oauth/authorize?${authorize}`, { headers: forwarded });
    expect(after.status).toBe(200);
    expect(await after.text()).toContain('Agent Core API key');
  });
});
