import path from 'node:path';

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  logDir: string;
  capabilityDir: string;
  allowedRoots: string[];
}

type Env = Record<string, string | undefined>;

function parseRoots(value: string | undefined, baseDir: string): string[] {
  if (!value?.trim()) return [path.resolve(baseDir)];
  const roots = value.split(';')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(item));
  return roots.length ? [...new Set(roots)] : [path.resolve(baseDir)];
}

export function loadConfig(env: Env = process.env, baseDir = process.cwd()): AppConfig {
  const port = Number.parseInt(env.COMMANDER_PORT ?? '8765', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('COMMANDER_PORT must be an integer between 1 and 65535');
  }

  return {
    host: env.COMMANDER_HOST?.trim() || '127.0.0.1',
    port,
    dataDir: path.resolve(env.COMMANDER_DATA_DIR?.trim() || path.join(baseDir, 'data')),
    logDir: path.resolve(env.COMMANDER_LOG_DIR?.trim() || path.join(baseDir, 'logs')),
    capabilityDir: path.resolve(env.COMMANDER_CAPABILITY_DIR?.trim() || path.join(baseDir, 'capabilities')),
    allowedRoots: parseRoots(env.COMMANDER_ALLOWED_ROOTS, baseDir),
  };
}
