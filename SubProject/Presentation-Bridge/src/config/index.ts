import { resolve } from 'node:path';
import type { SecurityLimits } from '../types/contracts.js';

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export interface BridgeConfig {
  cwd: string;
  runtimeRoot: string;
  googleCredentialsPath: string;
  googleTokenPath: string;
  googleFolderId?: string;
  keynoteWorker: 'local' | 'remote';
  limits: SecurityLimits;
}

export function loadConfig(cwd = process.cwd()): BridgeConfig {
  const worker = process.env.PB_KEYNOTE_WORKER ?? 'local';
  if (worker !== 'local' && worker !== 'remote') throw new Error('PB_KEYNOTE_WORKER must be local or remote');
  const folderId = process.env.PB_GOOGLE_FOLDER_ID?.trim();
  return {
    cwd,
    runtimeRoot: resolve(cwd, 'runtime', 'jobs'),
    googleCredentialsPath: resolve(cwd, process.env.PB_GOOGLE_CREDENTIALS ?? './secrets/google/oauth-client.json'),
    googleTokenPath: resolve(cwd, process.env.PB_GOOGLE_TOKEN ?? './secrets/google/token.json'),
    ...(folderId ? { googleFolderId: folderId } : {}),
    keynoteWorker: worker,
    limits: {
      maxSourceBytes: intEnv('PB_MAX_SOURCE_BYTES', 200 * 1024 * 1024),
      maxExpandedBytes: intEnv('PB_MAX_EXPANDED_BYTES', 1024 * 1024 * 1024),
      maxEntryBytes: intEnv('PB_MAX_ENTRY_BYTES', 256 * 1024 * 1024),
      maxZipEntries: intEnv('PB_MAX_ZIP_ENTRIES', 20_000)
    }
  };
}
