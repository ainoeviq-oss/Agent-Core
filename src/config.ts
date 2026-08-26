import path from 'node:path';

export interface MemoryScoreWeights {
  lexical: number;
  exact: number;
  graph: number;
  state: number;
  importance: number;
  recency: number;
}

export interface MemoryConfig {
  enabled: boolean;
  enforceHardGuardrails: boolean;
  dbPath: string;
  seedCap: number;
  graphNodeCap: number;
  graphEdgeCap: number;
  graphMaxHops: number;
  pprDamping: number;
  pprEpsilon: number;
  pprMaxIterations: number;
  recallItemBudget: number;
  recallCharacterBudget: number;
  busyTimeoutMs: number;
  tokenOverlapJaccardThreshold: number;
  temporalNeighborWindowMs: number;
  archiveObservationAfterMs: number;
  tombstoneRetentionMs: number;
  scoreWeights: MemoryScoreWeights;
}

export interface ExecutionConfig {
  enabled: boolean;
  dbPath: string;
  logRoot: string;
  maxConcurrency: number;
  maxNodes: number;
  waitMaxMs: number;
  busyTimeoutMs: number;
}

export interface GitHubConfig {
  enabled: boolean;
  apiBaseUrl: string;
  apiVersion: string;
  tokenFile: string;
  packagesTokenFile: string;
  requestTimeoutMs: number;
  gitTimeoutMs: number;
}

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  logDir: string;
  capabilityDir: string;
  allowedRoots: string[];
  memory: MemoryConfig;
  execution: ExecutionConfig;
  github: GitHubConfig;
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

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function parseUnitInterval(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) throw new Error(`${name} must be between 0 and 1`);
  return parsed;
}

function parseGitHubApiBaseUrl(value: string | undefined): string {
  const raw = value?.trim() || 'https://api.github.com';
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('AGENT_CORE_GITHUB_API_BASE_URL must be a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('AGENT_CORE_GITHUB_API_BASE_URL must use http or https');
  }
  return raw.replace(/\/+$/g, '');
}

export function loadConfig(env: Env = process.env, baseDir = process.cwd()): AppConfig {
  const port = Number.parseInt(env.AGENT_CORE_PORT ?? '8765', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('AGENT_CORE_PORT must be an integer between 1 and 65535');
  }

  const memory: MemoryConfig = {
    enabled: parseBoolean(env.AGENT_CORE_MEMORY_ENABLED, true),
    enforceHardGuardrails: parseBoolean(env.AGENT_CORE_MEMORY_ENFORCE_HARD_GUARDRAILS, false),
    dbPath: path.resolve(env.AGENT_CORE_MEMORY_DB_PATH?.trim() || path.join(baseDir, 'runtime', 'memory', 'agent-core-memory.sqlite')),
    seedCap: parsePositiveInteger(env.AGENT_CORE_MEMORY_SEED_CAP, 64, 'AGENT_CORE_MEMORY_SEED_CAP'),
    graphNodeCap: parsePositiveInteger(env.AGENT_CORE_MEMORY_GRAPH_NODE_CAP, 1000, 'AGENT_CORE_MEMORY_GRAPH_NODE_CAP'),
    graphEdgeCap: parsePositiveInteger(env.AGENT_CORE_MEMORY_GRAPH_EDGE_CAP, 10_000, 'AGENT_CORE_MEMORY_GRAPH_EDGE_CAP'),
    graphMaxHops: parsePositiveInteger(env.AGENT_CORE_MEMORY_GRAPH_MAX_HOPS, 2, 'AGENT_CORE_MEMORY_GRAPH_MAX_HOPS'),
    pprDamping: parseUnitInterval(env.AGENT_CORE_MEMORY_PPR_DAMPING, 0.85, 'AGENT_CORE_MEMORY_PPR_DAMPING'),
    pprEpsilon: Number(env.AGENT_CORE_MEMORY_PPR_EPSILON ?? '0.000001'),
    pprMaxIterations: parsePositiveInteger(env.AGENT_CORE_MEMORY_PPR_MAX_ITERATIONS, 20, 'AGENT_CORE_MEMORY_PPR_MAX_ITERATIONS'),
    recallItemBudget: parsePositiveInteger(env.AGENT_CORE_MEMORY_RECALL_ITEM_BUDGET, 24, 'AGENT_CORE_MEMORY_RECALL_ITEM_BUDGET'),
    recallCharacterBudget: parsePositiveInteger(env.AGENT_CORE_MEMORY_RECALL_CHARACTER_BUDGET, 12_000, 'AGENT_CORE_MEMORY_RECALL_CHARACTER_BUDGET'),
    busyTimeoutMs: parsePositiveInteger(env.AGENT_CORE_MEMORY_BUSY_TIMEOUT_MS, 5000, 'AGENT_CORE_MEMORY_BUSY_TIMEOUT_MS'),
    tokenOverlapJaccardThreshold: parseUnitInterval(env.AGENT_CORE_MEMORY_TOKEN_JACCARD, 0.35, 'AGENT_CORE_MEMORY_TOKEN_JACCARD'),
    temporalNeighborWindowMs: parsePositiveInteger(env.AGENT_CORE_MEMORY_TEMPORAL_WINDOW_MS, 30 * 60 * 1000, 'AGENT_CORE_MEMORY_TEMPORAL_WINDOW_MS'),
    archiveObservationAfterMs: parsePositiveInteger(env.AGENT_CORE_MEMORY_ARCHIVE_OBSERVATION_MS, 90 * 24 * 60 * 60 * 1000, 'AGENT_CORE_MEMORY_ARCHIVE_OBSERVATION_MS'),
    tombstoneRetentionMs: parsePositiveInteger(env.AGENT_CORE_MEMORY_TOMBSTONE_RETENTION_MS, 30 * 24 * 60 * 60 * 1000, 'AGENT_CORE_MEMORY_TOMBSTONE_RETENTION_MS'),
    scoreWeights: {
      lexical: 0.40,
      exact: 0.20,
      graph: 0.20,
      state: 0.08,
      importance: 0.07,
      recency: 0.05,
    },
  };

  if (!Number.isFinite(memory.pprEpsilon) || memory.pprEpsilon <= 0) {
    throw new Error('AGENT_CORE_MEMORY_PPR_EPSILON must be positive');
  }

  const execution: ExecutionConfig = {
    // Production default is enabled after the staged Task 22 live canary; operators can still disable it explicitly.
    enabled: parseBoolean(env.AGENT_CORE_EXECUTION_ENABLED, true),
    dbPath: path.resolve(env.AGENT_CORE_EXECUTION_DB_PATH?.trim() || path.join(baseDir, 'runtime', 'execution', 'agent-core-execution.sqlite')),
    logRoot: path.resolve(env.AGENT_CORE_EXECUTION_LOG_ROOT?.trim() || path.join(baseDir, 'runtime', 'execution', 'runs')),
    maxConcurrency: parsePositiveInteger(env.AGENT_CORE_EXECUTION_MAX_CONCURRENCY, 4, 'AGENT_CORE_EXECUTION_MAX_CONCURRENCY'),
    maxNodes: parsePositiveInteger(env.AGENT_CORE_EXECUTION_MAX_NODES, 128, 'AGENT_CORE_EXECUTION_MAX_NODES'),
    waitMaxMs: parsePositiveInteger(env.AGENT_CORE_EXECUTION_WAIT_MAX_MS, 60_000, 'AGENT_CORE_EXECUTION_WAIT_MAX_MS'),
    busyTimeoutMs: parsePositiveInteger(env.AGENT_CORE_EXECUTION_BUSY_TIMEOUT_MS, 5_000, 'AGENT_CORE_EXECUTION_BUSY_TIMEOUT_MS'),
  };

  const github: GitHubConfig = {
    enabled: parseBoolean(env.AGENT_CORE_GITHUB_ENABLED, true),
    apiBaseUrl: parseGitHubApiBaseUrl(env.AGENT_CORE_GITHUB_API_BASE_URL),
    apiVersion: env.AGENT_CORE_GITHUB_API_VERSION?.trim() || '2026-03-10',
    tokenFile: path.resolve(env.AGENT_CORE_GITHUB_TOKEN_FILE?.trim() || path.join(baseDir, 'secrets', 'github', 'gh-token.txt')),
    packagesTokenFile: path.resolve(env.AGENT_CORE_GITHUB_PACKAGES_TOKEN_FILE?.trim() || path.join(baseDir, 'secrets', 'github', 'packages-token.txt')),
    requestTimeoutMs: parsePositiveInteger(env.AGENT_CORE_GITHUB_REQUEST_TIMEOUT_MS, 30_000, 'AGENT_CORE_GITHUB_REQUEST_TIMEOUT_MS'),
    gitTimeoutMs: parsePositiveInteger(env.AGENT_CORE_GITHUB_GIT_TIMEOUT_MS, 120_000, 'AGENT_CORE_GITHUB_GIT_TIMEOUT_MS'),
  };

  return {
    host: env.AGENT_CORE_HOST?.trim() || '127.0.0.1',
    port,
    dataDir: path.resolve(env.AGENT_CORE_DATA_DIR?.trim() || path.join(baseDir, 'data')),
    logDir: path.resolve(env.AGENT_CORE_LOG_DIR?.trim() || path.join(baseDir, 'logs')),
    capabilityDir: path.resolve(env.AGENT_CORE_CAPABILITY_DIR?.trim() || path.join(baseDir, 'capabilities')),
    allowedRoots: parseRoots(env.AGENT_CORE_ALLOWED_ROOTS, baseDir),
    memory,
    execution,
    github,
  };
}
