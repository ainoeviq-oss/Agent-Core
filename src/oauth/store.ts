import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CLIENT_ID_PREFIX = 'cmdr_client_';
const CLIENT_SECRET_PREFIX = 'cmdr_secret_';
const CODE_PREFIX = 'cmdr_code_';
export const ACCESS_TOKEN_PREFIX = 'cmdr_oauth_';
const REFRESH_TOKEN_PREFIX = 'cmdr_refresh_';

export interface OAuthPrincipal {
  clientId: string;
  resource: string;
  scopes: string[];
  keyId: string;
  keyName: string;
}

interface ClientRecord {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod: string;
  secretHash: string;
  createdAt: string;
}

interface CodeRecord extends OAuthPrincipal {
  hash: string;
  redirectUri: string;
  codeChallenge: string;
  expiresAt: string;
  usedAt: string | null;
}
interface AccessTokenRecord extends OAuthPrincipal {
  hash: string;
  expiresAt: string;
}

interface RefreshTokenRecord extends OAuthPrincipal {
  hash: string;
  expiresAt: string;
  revokedAt: string | null;
}

interface OAuthFile {
  version: 1;
  clients: ClientRecord[];
  codes: CodeRecord[];
  accessTokens: AccessTokenRecord[];
  refreshTokens: RefreshTokenRecord[];
}

export interface RegisteredClient {
  client_id: string;
  client_secret: string;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  client_id_issued_at: number;
  client_secret_expires_at: 0;
}

export interface PublicClient {
  clientId: string;
  redirectUris: string[];
}
function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('base64');
}

function safeHashEqual(secret: string, expectedBase64: string): boolean {
  const actual = Buffer.from(hashSecret(secret), 'base64');
  const expected = Buffer.from(expectedBase64, 'base64');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function freshSecret(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

function emptyFile(): OAuthFile {
  return { version: 1, clients: [], codes: [], accessTokens: [], refreshTokens: [] };
}

function expiry(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

export class FileOAuthStore {
  readonly filePath: string;

  constructor(private readonly dataDir: string) {
    this.filePath = path.join(dataDir, 'oauth.json');
  }

  private async load(): Promise<OAuthFile> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as OAuthFile;
      if (parsed.version !== 1) throw new Error('Unsupported OAuth store format');
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyFile();
      throw error;
    }
  }

  private async save(file: OAuthFile): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: 'utf8', mode: 0o600,
    });
    await rename(temporary, this.filePath);
  }

  async registerClient(input: {
    clientName: string;
    redirectUris: string[];
    grantTypes: string[];
    responseTypes: string[];
    tokenEndpointAuthMethod: string;
  }): Promise<RegisteredClient> {
    const secret = freshSecret(CLIENT_SECRET_PREFIX);
    const now = new Date();
    const record: ClientRecord = {
      clientId: `${CLIENT_ID_PREFIX}${randomUUID()}`,
      clientName: input.clientName,
      redirectUris: [...input.redirectUris],
      grantTypes: [...input.grantTypes],
      responseTypes: [...input.responseTypes],
      tokenEndpointAuthMethod: input.tokenEndpointAuthMethod,
      secretHash: hashSecret(secret),
      createdAt: now.toISOString(),
    };
    const file = await this.load();
    file.clients.push(record);
    await this.save(file);
    return {
      client_id: record.clientId,
      client_secret: secret,
      client_name: record.clientName,
      redirect_uris: record.redirectUris,
      grant_types: record.grantTypes,
      response_types: record.responseTypes,
      token_endpoint_auth_method: record.tokenEndpointAuthMethod,
      client_id_issued_at: Math.floor(now.getTime() / 1000),
      client_secret_expires_at: 0,
    };
  }

  async getClient(clientId: string): Promise<PublicClient | null> {
    const file = await this.load();
    const client = file.clients.find((item) => item.clientId === clientId);
    return client ? { clientId, redirectUris: [...client.redirectUris] } : null;
  }

  async verifyClient(clientId: string, secret: string): Promise<boolean> {
    const file = await this.load();
    const client = file.clients.find((item) => item.clientId === clientId);
    return client ? safeHashEqual(secret, client.secretHash) : false;
  }

  async issueCode(input: OAuthPrincipal & {
    redirectUri: string;
    codeChallenge: string;
  }): Promise<string> {
    const raw = freshSecret(CODE_PREFIX);
    const file = await this.load();
    file.codes.push({
      ...input,
      hash: hashSecret(raw),
      expiresAt: expiry(300),
      usedAt: null,
    });
    await this.save(file);
    return raw;
  }

  async consumeCode(raw: string, input: {
    clientId: string;
    redirectUri: string;
    codeVerifier: string;
    resource: string;
  }): Promise<OAuthPrincipal | null> {
    if (!raw.startsWith(CODE_PREFIX)) return null;
    const file = await this.load();
    const record = file.codes.find((item) => safeHashEqual(raw, item.hash));
    if (!record || record.usedAt || Date.parse(record.expiresAt) <= Date.now()) return null;
    if (record.clientId !== input.clientId || record.redirectUri !== input.redirectUri) return null;
    if (record.resource !== input.resource) return null;
    const challenge = createHash('sha256').update(input.codeVerifier).digest('base64url');
    if (challenge !== record.codeChallenge) return null;

    record.usedAt = new Date().toISOString();
    await this.save(file);
    return {
      clientId: record.clientId,
      resource: record.resource,
      scopes: [...record.scopes],
      keyId: record.keyId,
      keyName: record.keyName,
    };
  }

  async issueTokens(principal: OAuthPrincipal): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  }> {
    const accessToken = freshSecret(ACCESS_TOKEN_PREFIX);
    const refreshToken = freshSecret(REFRESH_TOKEN_PREFIX);
    const expiresIn = 3600;
    const file = await this.load();
    file.accessTokens.push({
      ...principal,
      hash: hashSecret(accessToken),
      expiresAt: expiry(expiresIn),
    });
    file.refreshTokens.push({
      ...principal,
      hash: hashSecret(refreshToken),
      expiresAt: expiry(30 * 24 * 3600),
      revokedAt: null,
    });
    await this.save(file);
    return { accessToken, refreshToken, expiresIn };
  }

  async verifyAccessToken(raw: string): Promise<OAuthPrincipal | null> {
    if (!raw.startsWith(ACCESS_TOKEN_PREFIX)) return null;
    const file = await this.load();
    const record = file.accessTokens.find((item) => safeHashEqual(raw, item.hash));
    if (!record || Date.parse(record.expiresAt) <= Date.now()) return null;
    return {
      clientId: record.clientId,
      resource: record.resource,
      scopes: [...record.scopes],
      keyId: record.keyId,
      keyName: record.keyName,
    };
  }
  async consumeRefreshToken(raw: string, input: {
    clientId: string;
    resource: string;
  }): Promise<OAuthPrincipal | null> {
    if (!raw.startsWith(REFRESH_TOKEN_PREFIX)) return null;
    const file = await this.load();
    const record = file.refreshTokens.find((item) => safeHashEqual(raw, item.hash));
    if (!record || record.revokedAt || Date.parse(record.expiresAt) <= Date.now()) return null;
    if (record.clientId !== input.clientId || record.resource !== input.resource) return null;

    record.revokedAt = new Date().toISOString();
    await this.save(file);
    return {
      clientId: record.clientId,
      resource: record.resource,
      scopes: [...record.scopes],
      keyId: record.keyId,
      keyName: record.keyName,
    };
  }
}
