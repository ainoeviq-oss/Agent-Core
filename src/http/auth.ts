import type { IncomingMessage } from 'node:http';
import type { FileKeyStore } from '../auth/key-store.js';
import type { VerifiedKey } from '../auth/key-types.js';
import type { OAuthService } from '../oauth/service.js';

export function parseBearerToken(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const match = /^Bearer ([^\s]+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export async function authenticateRequest(
  request: IncomingMessage,
  keyStore: FileKeyStore,
  oauthService?: OAuthService,
): Promise<VerifiedKey | null> {
  const token = parseBearerToken(request);
  if (!token) return null;
  const key = await keyStore.verify(token);
  if (key) return { ...key, authentication: 'bearer-api-key' };
  return oauthService?.authenticateAccessToken(token) ?? null;
}
