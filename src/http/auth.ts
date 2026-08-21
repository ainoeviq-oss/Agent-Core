import type { IncomingMessage } from 'node:http';
import type { FileKeyStore } from '../auth/key-store.js';
import type { VerifiedKey } from '../auth/key-types.js';

export function parseBearerToken(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const match = /^Bearer ([^\s]+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export async function authenticateRequest(
  request: IncomingMessage,
  keyStore: FileKeyStore,
): Promise<VerifiedKey | null> {
  const token = parseBearerToken(request);
  if (!token) return null;
  return keyStore.verify(token);
}
