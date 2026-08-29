import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  evaluateBridgeHealth,
  readNewTunnelLogLines,
  type RuntimeStatus,
  type WatchdogState,
} from '../src/watchdog.js';

const expectedTunnelId = 'tunnel_expected';
const expectedMcpServerUrl = 'http://127.0.0.1:38765/mcp';
const nowMs = 1_000_000;

const healthyStatus: RuntimeStatus = {
  process_running: true,
  healthy: true,
  ready: true,
  runtime_state: 'ready',
  stale: false,
  tunnel_id: expectedTunnelId,
  remote_lookup_attempted: true,
  remote_error: '',
  remote_lookup_auth_ref: 'file:/workspaces/Agent-Core/secrets/github/CONTROL_PLANE_API_KEY',
  remote: { id: expectedTunnelId },
  process: {
    target_kind: 'url',
    target_value: expectedMcpServerUrl,
  },
};

const failureLine = (time: string) => JSON.stringify({
  time,
  level: 'ERROR',
  msg: 'dispatcher received MCP upstream error; posted error response to control plane',
  component: 'dispatcher',
  status_code: 502,
  failure_source: 'client_internal',
  upstream_response_received: false,
});

const successLine = (time: string) => JSON.stringify({
  time,
  level: 'INFO',
  msg: 'dispatcher forwarded command to MCP server',
  component: 'dispatcher',
});

function evaluate(overrides: Partial<Parameters<typeof evaluateBridgeHealth>[0]> = {}) {
  return evaluateBridgeHealth({
    localMcpHealthy: true,
    runtimeStatus: healthyStatus,
    expectedTunnelId,
    expectedMcpServerUrl,
    newLogLines: [],
    previousFailureStreak: 0,
    failureThreshold: 3,
    nowMs,
    lastRepairAt: 0,
    cooldownMs: 15_000,
    ...overrides,
  });
}

describe('codespace watchdog health classifier', () => {
  it('keeps a fully healthy HTTP MCP runtime running', () => {
    expect(evaluate()).toEqual({
      repair: false,
      reason: 'healthy',
      failureStreak: 0,
    });
  });

  it('repairs immediately when the loopback MCP health endpoint is dead', () => {
    expect(evaluate({ localMcpHealthy: false })).toMatchObject({
      repair: true,
      reason: 'local_mcp_unhealthy',
    });
  });

  it('repairs a missing, stale, wrongly routed, or remotely unregistered tunnel runtime', () => {
    expect(evaluate({ runtimeStatus: { ...healthyStatus, process_running: false } }).reason)
      .toBe('runtime_unhealthy');
    expect(evaluate({ runtimeStatus: { ...healthyStatus, stale: true } }).reason)
      .toBe('runtime_unhealthy');
    expect(evaluate({ runtimeStatus: { ...healthyStatus, tunnel_id: 'tunnel_wrong' } }).reason)
      .toBe('runtime_unhealthy');
    expect(evaluate({
      runtimeStatus: {
        ...healthyStatus,
        process: { target_kind: 'command', target_value: 'bash old-stdio.sh' },
      },
    }).reason).toBe('runtime_unhealthy');
    expect(evaluate({ runtimeStatus: { ...healthyStatus, remote_error: 'lookup failed' } }).reason)
      .toBe('runtime_unhealthy');
  });

  it('repairs after three consecutive internal 502 responses without an upstream MCP response', () => {
    const decision = evaluate({
      newLogLines: [
        failureLine('2026-08-29T14:17:19.901Z'),
        failureLine('2026-08-29T14:17:19.902Z'),
        failureLine('2026-08-29T14:17:19.903Z'),
      ],
    });
    expect(decision).toEqual({
      repair: true,
      reason: 'repeated_internal_502',
      failureStreak: 3,
    });
  });

  it('does not classify ordinary log noise or a recovered forward as a poisoned route', () => {
    const decision = evaluate({
      previousFailureStreak: 1,
      newLogLines: [
        failureLine('2026-08-29T14:17:19.901Z'),
        JSON.stringify({ level: 'ERROR', msg: 'ordinary tool error', status_code: 500 }),
        successLine('2026-08-29T14:17:20.000Z'),
        failureLine('2026-08-29T14:17:20.100Z'),
        failureLine('2026-08-29T14:17:20.200Z'),
      ],
    });
    expect(decision).toEqual({
      repair: false,
      reason: 'healthy',
      failureStreak: 2,
    });
  });

  it('uses a cooldown to prevent recursive repair storms', () => {
    expect(evaluate({
      localMcpHealthy: false,
      lastRepairAt: nowMs - 2_000,
    })).toEqual({
      repair: false,
      reason: 'cooldown_active',
      failureStreak: 0,
    });
  });
});

describe('codespace watchdog tunnel-log cursor', () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await fs.rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it('ignores historical failures on first observation and reads only appended complete records', async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codespace-watchdog-'));
    const logPath = path.join(directory, 'codespace.log');
    await fs.writeFile(logPath, `${failureLine('2026-08-29T14:00:00.000Z')}\n`, 'utf8');

    const initial = await readNewTunnelLogLines(logPath, undefined);
    expect(initial.lines).toEqual([]);
    expect(initial.state.logOffset).toBeGreaterThan(0);

    await fs.appendFile(logPath, [
      failureLine('2026-08-29T14:17:19.901Z'),
      failureLine('2026-08-29T14:17:19.902Z'),
      failureLine('2026-08-29T14:17:19.903Z'),
      '',
    ].join('\n'), 'utf8');

    const appended = await readNewTunnelLogLines(logPath, initial.state);
    expect(appended.lines).toHaveLength(3);
    expect(appended.state.logOffset).toBeGreaterThan(initial.state.logOffset);

    const unchanged = await readNewTunnelLogLines(logPath, appended.state as WatchdogState);
    expect(unchanged.lines).toEqual([]);
    expect(unchanged.state.logOffset).toBe(appended.state.logOffset);
  });
});
