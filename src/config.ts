import path from 'node:path';

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  logDir: string;
}

type Env = Record<string, string | undefined>;

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
  };
}
