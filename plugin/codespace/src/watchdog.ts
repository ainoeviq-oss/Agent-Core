import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { PACKAGE_ROOT, RUNTIME_DIR, sanitizeEnvironment } from './constants.js';

const execFileAsync = promisify(execFile);
const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 15_000;
const MAX_LOG_READ_BYTES = 2 * 1024 * 1024;

export interface RuntimeStatus {
  process_running?: boolean;
  healthy?: boolean;
  ready?: boolean;
  runtime_state?: string;
  stale?: boolean;
  tunnel_id?: string;
  remote_lookup_attempted?: boolean;
  remote_error?: string;
  remote_lookup_auth_ref?: string;
  remote?: { id?: string };
  process?: {
    target_kind?: string;
    target_value?: string;
  };
}

export interface WatchdogState {
  version?: number;
  logInode?: number;
  logOffset: number;
  logRemainder?: string;
  failureStreak?: number;
  lastRepairAt?: number;
}

export interface BridgeHealthInput {
  localMcpHealthy: boolean;
  runtimeStatus: RuntimeStatus;
  expectedTunnelId: string;
  expectedMcpServerUrl: string;
  newLogLines: string[];
  previousFailureStreak: number;
  failureThreshold: number;
  nowMs: number;
  lastRepairAt: number;
  cooldownMs: number;
}

export interface RepairDecision {
  repair: boolean;
  reason: 'healthy' | 'local_mcp_unhealthy' | 'runtime_unhealthy' | 'repeated_internal_502' | 'cooldown_active';
  failureStreak: number;
}

interface TunnelLogRecord {
  msg?: unknown;
  component?: unknown;
  status_code?: unknown;
  failure_source?: unknown;
  upstream_response_received?: unknown;
}

function isInternalUpstreamFailure(record: TunnelLogRecord): boolean {
  return record.component === 'dispatcher'
    && record.msg === 'dispatcher received MCP upstream error; posted error response to control plane'
    && record.status_code === 502
    && record.failure_source === 'client_internal'
    && record.upstream_response_received === false;
}

function isSuccessfulForward(record: TunnelLogRecord): boolean {
  return record.component === 'dispatcher'
    && record.msg === 'dispatcher forwarded command to MCP server';
}

function isFreshRuntime(record: TunnelLogRecord): boolean {
  return record.msg === '🟢 tunnel-client started';
}

export function updateFailureStreak(lines: string[], previousFailureStreak: number): number {
  let failureStreak = Math.max(0, previousFailureStreak);
  for (const line of lines) {
    if (!line.trim()) continue;
    let record: TunnelLogRecord;
    try {
      record = JSON.parse(line) as TunnelLogRecord;
    } catch {
      continue;
    }
    if (isSuccessfulForward(record) || isFreshRuntime(record)) {
      failureStreak = 0;
    } else if (isInternalUpstreamFailure(record)) {
      failureStreak += 1;
    }
  }
  return failureStreak;
}

function runtimeIsHealthy(
  status: RuntimeStatus,
  expectedTunnelId: string,
  expectedMcpServerUrl: string,
): boolean {
  return status.process_running === true
    && status.healthy === true
    && status.ready === true
    && status.runtime_state === 'ready'
    && status.stale === false
    && status.tunnel_id === expectedTunnelId
    && status.remote_lookup_attempted === true
    && status.remote_error === ''
    && status.remote?.id === expectedTunnelId
    && typeof status.remote_lookup_auth_ref === 'string'
    && status.remote_lookup_auth_ref.startsWith('file:')
    && status.process?.target_kind === 'server_url'
    && status.process?.target_value === expectedMcpServerUrl;
}

export function evaluateBridgeHealth(input: BridgeHealthInput): RepairDecision {
  const failureStreak = updateFailureStreak(input.newLogLines, input.previousFailureStreak);
  let reason: RepairDecision['reason'] = 'healthy';

  if (!input.localMcpHealthy) {
    reason = 'local_mcp_unhealthy';
  } else if (!runtimeIsHealthy(
    input.runtimeStatus,
    input.expectedTunnelId,
    input.expectedMcpServerUrl,
  )) {
    reason = 'runtime_unhealthy';
  } else if (failureStreak >= input.failureThreshold) {
    reason = 'repeated_internal_502';
  }

  if (reason === 'healthy') {
    return { repair: false, reason, failureStreak };
  }

  const cooldownActive = input.lastRepairAt > 0
    && input.nowMs - input.lastRepairAt < input.cooldownMs;
  if (cooldownActive) {
    return { repair: false, reason: 'cooldown_active', failureStreak };
  }
  return { repair: true, reason, failureStreak };
}

export async function readNewTunnelLogLines(
  logPath: string,
  previousState: WatchdogState | undefined,
): Promise<{ lines: string[]; state: WatchdogState }> {
  let stat;
  try {
    stat = await fs.stat(logPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        lines: [],
        state: {
          ...previousState,
          version: 1,
          logInode: undefined,
          logOffset: 0,
          logRemainder: '',
        },
      };
    }
    throw error;
  }

  const sameFile = previousState?.logInode === stat.ino
    && stat.size >= (previousState?.logOffset ?? 0);
  if (!previousState || !sameFile) {
    return {
      lines: [],
      state: {
        ...previousState,
        version: 1,
        logInode: stat.ino,
        logOffset: stat.size,
        logRemainder: '',
      },
    };
  }

  if (stat.size === previousState.logOffset) {
    return {
      lines: [],
      state: { ...previousState, version: 1, logInode: stat.ino },
    };
  }

  const availableBytes = stat.size - previousState.logOffset;
  const bytesToRead = Math.min(availableBytes, MAX_LOG_READ_BYTES);
  const start = stat.size - bytesToRead;
  const handle = await fs.open(logPath, 'r');
  let text = '';
  try {
    const buffer = Buffer.alloc(bytesToRead);
    await handle.read(buffer, 0, bytesToRead, start);
    text = buffer.toString('utf8');
  } finally {
    await handle.close();
  }

  const prefix = start === previousState.logOffset ? previousState.logRemainder ?? '' : '';
  const records = `${prefix}${text}`.split(/\r?\n/);
  const remainder = records.pop() ?? '';
  return {
    lines: records,
    state: {
      ...previousState,
      version: 1,
      logInode: stat.ino,
      logOffset: stat.size,
      logRemainder: remainder,
    },
  };
}

interface WatchdogConfig {
  alias: string;
  bin: string;
  stateDir: string;
  stateFile: string;
  tunnelLog: string;
  expectedTunnelId: string;
  expectedMcpServerUrl: string;
  healthUrl: string;
  ensureRunningScript: string;
  intervalMs: number;
  failureThreshold: number;
  cooldownMs: number;
  once: boolean;
}

function positiveInteger(raw: string | undefined, fallback: number, name: string): number {
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

async function readExpectedTunnelId(): Promise<string> {
  const configured = process.env.CODESPACE_EXPECTED_TUNNEL_ID?.trim();
  if (configured) return configured;
  const defaults = JSON.parse(
    await fs.readFile(path.join(PACKAGE_ROOT, 'config', 'tunnel.defaults.json'), 'utf8'),
  ) as { tunnelId?: unknown };
  if (typeof defaults.tunnelId !== 'string' || !/^tunnel_[A-Za-z0-9_-]+$/.test(defaults.tunnelId)) {
    throw new Error('Tracked tunnel identity is unavailable or invalid.');
  }
  return defaults.tunnelId;
}

async function readExpectedMcpServerUrl(): Promise<string> {
  const configured = process.env.CODESPACE_MCP_SERVER_URL?.trim();
  if (configured) return configured;
  return (await fs.readFile(path.join(RUNTIME_DIR, 'state', 'http-mcp.url'), 'utf8')).trim();
}

async function loadConfig(): Promise<WatchdogConfig> {
  const expectedTunnelId = await readExpectedTunnelId();
  const expectedMcpServerUrl = await readExpectedMcpServerUrl();
  const parsedUrl = new URL(expectedMcpServerUrl);
  if (parsedUrl.protocol !== 'http:' || parsedUrl.hostname !== '127.0.0.1' || parsedUrl.pathname !== '/mcp') {
    throw new Error('Watchdog MCP URL must be a loopback Streamable HTTP endpoint.');
  }
  parsedUrl.pathname = '/healthz';

  return {
    alias: process.env.CODESPACE_TUNNEL_ALIAS?.trim() || 'codespace',
    bin: process.env.CODESPACE_TUNNEL_CLIENT_BIN?.trim()
      || path.join(RUNTIME_DIR, 'bin', 'tunnel-client'),
    stateDir: process.env.TUNNEL_CLIENT_STATE_DIR?.trim()
      || path.join(RUNTIME_DIR, 'state'),
    stateFile: process.env.CODESPACE_WATCHDOG_STATE_FILE?.trim()
      || path.join(RUNTIME_DIR, 'state', 'watchdog.json'),
    tunnelLog: process.env.CODESPACE_TUNNEL_LOG_FILE?.trim()
      || path.join(RUNTIME_DIR, 'state', 'logs', 'codespace.log'),
    expectedTunnelId,
    expectedMcpServerUrl,
    healthUrl: parsedUrl.toString(),
    ensureRunningScript: process.env.CODESPACE_ENSURE_RUNNING_SCRIPT?.trim()
      || path.join(PACKAGE_ROOT, 'scripts', 'ensure-running.sh'),
    intervalMs: positiveInteger(
      process.env.CODESPACE_WATCHDOG_INTERVAL_MS,
      DEFAULT_INTERVAL_MS,
      'CODESPACE_WATCHDOG_INTERVAL_MS',
    ),
    failureThreshold: positiveInteger(
      process.env.CODESPACE_WATCHDOG_FAILURE_THRESHOLD,
      DEFAULT_FAILURE_THRESHOLD,
      'CODESPACE_WATCHDOG_FAILURE_THRESHOLD',
    ),
    cooldownMs: positiveInteger(
      process.env.CODESPACE_WATCHDOG_COOLDOWN_MS,
      DEFAULT_COOLDOWN_MS,
      'CODESPACE_WATCHDOG_COOLDOWN_MS',
    ),
    once: process.argv.includes('--once'),
  };
}

async function loadState(stateFile: string): Promise<WatchdogState | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(stateFile, 'utf8')) as WatchdogState;
    return typeof parsed.logOffset === 'number' ? parsed : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function saveState(stateFile: string, state: WatchdogState): Promise<void> {
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  const temporaryPath = `${stateFile}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify({ ...state, version: 1 })}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fs.rename(temporaryPath, stateFile);
  await fs.chmod(stateFile, 0o600);
}

async function probeLocalHealth(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(1_500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function readRuntimeStatus(config: WatchdogConfig): Promise<RuntimeStatus> {
  try {
    const { stdout } = await execFileAsync(
      config.bin,
      ['runtimes', 'status', config.alias, '--json'],
      {
        env: {
          ...sanitizeEnvironment(),
          TUNNEL_CLIENT_STATE_DIR: config.stateDir,
        },
        timeout: 5_000,
        maxBuffer: 2 * 1024 * 1024,
        encoding: 'utf8',
      },
    );
    return JSON.parse(stdout) as RuntimeStatus;
  } catch {
    return {};
  }
}

async function runRepair(config: WatchdogConfig, reason: string): Promise<void> {
  console.error(`[codespace-watchdog] repair starting reason=${reason}`);
  try {
    await execFileAsync(
      '/bin/bash',
      [config.ensureRunningScript, '--phase', 'manual', '--force-reconnect'],
      {
        cwd: PACKAGE_ROOT,
        env: {
          ...sanitizeEnvironment(),
          CODESPACE_WATCHDOG_ACTIVE: '1',
          CODESPACE_EXPECTED_TUNNEL_ID: config.expectedTunnelId,
          CODESPACE_MCP_SERVER_URL: config.expectedMcpServerUrl,
          TUNNEL_CLIENT_STATE_DIR: config.stateDir,
        },
        timeout: 4 * 60_000,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
      },
    );
    console.error(`[codespace-watchdog] repair completed reason=${reason}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[codespace-watchdog] repair failed reason=${reason} error=${message.slice(0, 500)}`);
  }
}

async function runIteration(config: WatchdogConfig): Promise<void> {
  const previousState = await loadState(config.stateFile);
  const logRead = await readNewTunnelLogLines(config.tunnelLog, previousState);
  const nowMs = Date.now();
  const [localMcpHealthy, runtimeStatus] = await Promise.all([
    probeLocalHealth(config.healthUrl),
    readRuntimeStatus(config),
  ]);
  const decision = evaluateBridgeHealth({
    localMcpHealthy,
    runtimeStatus,
    expectedTunnelId: config.expectedTunnelId,
    expectedMcpServerUrl: config.expectedMcpServerUrl,
    newLogLines: logRead.lines,
    previousFailureStreak: previousState?.failureStreak ?? 0,
    failureThreshold: config.failureThreshold,
    nowMs,
    lastRepairAt: previousState?.lastRepairAt ?? 0,
    cooldownMs: config.cooldownMs,
  });

  const nextState: WatchdogState = {
    ...logRead.state,
    failureStreak: decision.repair ? 0 : decision.failureStreak,
    lastRepairAt: decision.repair ? nowMs : previousState?.lastRepairAt ?? 0,
  };
  await saveState(config.stateFile, nextState);
  if (decision.repair) await runRepair(config, decision.reason);
}

async function main(): Promise<void> {
  delete process.env.CONTROL_PLANE_API_KEY;
  delete process.env.OPENAI_ADMIN_KEY;

  const config = await loadConfig();
  do {
    try {
      await runIteration(config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[codespace-watchdog] iteration failed: ${message.slice(0, 500)}`);
    }
    if (!config.once) await sleep(config.intervalMs);
  } while (!config.once);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  void main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[codespace-watchdog] startup failed: ${message.slice(0, 500)}`);
    process.exitCode = 1;
  });
}
