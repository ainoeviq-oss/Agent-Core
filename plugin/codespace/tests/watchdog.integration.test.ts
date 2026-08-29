import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watchdogEntry = path.join(pluginRoot, 'dist', 'watchdog.js');
const expectedTunnelId = 'tunnel_watchdog_integration';

let base: string;
let healthServer: Server | undefined;

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'codespace-watchdog-integration-'));
});

afterEach(async () => {
  if (healthServer) {
    await new Promise<void>((resolve) => healthServer?.close(() => resolve()));
    healthServer = undefined;
  }
  await fs.rm(base, { recursive: true, force: true });
});

async function startHealthServer(): Promise<string> {
  healthServer = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"ok"}\n');
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    healthServer?.once('error', reject);
    healthServer?.listen(0, '127.0.0.1', () => resolve());
  });
  const address = healthServer.address();
  if (!address || typeof address === 'string') throw new Error('Health server did not bind a TCP port.');
  return `http://127.0.0.1:${address.port}/mcp`;
}

function failureLine(sequence: number): string {
  return JSON.stringify({
    time: `2026-08-29T14:17:19.${900 + sequence}Z`,
    level: 'ERROR',
    msg: 'dispatcher received MCP upstream error; posted error response to control plane',
    component: 'dispatcher',
    status_code: 502,
    failure_source: 'client_internal',
    upstream_response_received: false,
  });
}

describe('codespace watchdog repair integration', () => {
  it('ignores historical failures, then invokes one sanitized forced reconnect after three new internal 502 events', async () => {
    const mcpUrl = await startHealthServer();
    const stateDir = path.join(base, 'state');
    const stateFile = path.join(stateDir, 'watchdog.json');
    const tunnelLog = path.join(stateDir, 'logs', 'codespace.log');
    const fakeBin = path.join(base, 'fake-tunnel-client');
    const fakeEnsure = path.join(base, 'fake-ensure-running.sh');
    const repairMarker = path.join(base, 'repair-marker.txt');

    await fs.mkdir(path.dirname(tunnelLog), { recursive: true });
    await fs.writeFile(tunnelLog, `${failureLine(0)}\n`, 'utf8');

    const status = {
      process_running: true,
      healthy: true,
      ready: true,
      runtime_state: 'ready',
      stale: false,
      tunnel_id: expectedTunnelId,
      remote_lookup_attempted: true,
      remote_error: '',
      remote_lookup_auth_ref: 'file:/ignored/runtime-key',
      remote: { id: expectedTunnelId },
      process: { target_kind: 'server_url', target_value: mcpUrl },
    };

    await fs.writeFile(fakeBin, `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' '${JSON.stringify(status)}'\n`, {
      encoding: 'utf8',
      mode: 0o755,
    });
    await fs.writeFile(fakeEnsure, `#!/usr/bin/env bash\nset -euo pipefail\nprintf 'args=%s secret=%s watchdog=%s\\n' "$*" "${'${CONTROL_PLANE_API_KEY-unset}'}" "${'${CODESPACE_WATCHDOG_ACTIVE-unset}'}" > ${JSON.stringify(repairMarker)}\n`, {
      encoding: 'utf8',
      mode: 0o755,
    });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CONTROL_PLANE_API_KEY: 'must-not-reach-repair',
      CODESPACE_EXPECTED_TUNNEL_ID: expectedTunnelId,
      CODESPACE_MCP_SERVER_URL: mcpUrl,
      CODESPACE_TUNNEL_CLIENT_BIN: fakeBin,
      CODESPACE_ENSURE_RUNNING_SCRIPT: fakeEnsure,
      CODESPACE_WATCHDOG_STATE_FILE: stateFile,
      CODESPACE_TUNNEL_LOG_FILE: tunnelLog,
      TUNNEL_CLIENT_STATE_DIR: stateDir,
      CODESPACE_WATCHDOG_FAILURE_THRESHOLD: '3',
      CODESPACE_WATCHDOG_COOLDOWN_MS: '15000',
    };

    await execFileAsync(process.execPath, [watchdogEntry, '--once'], {
      cwd: pluginRoot,
      env,
      timeout: 15_000,
    });
    await expect(fs.readFile(repairMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    await fs.appendFile(tunnelLog, `${failureLine(1)}\n${failureLine(2)}\n${failureLine(3)}\n`, 'utf8');
    await execFileAsync(process.execPath, [watchdogEntry, '--once'], {
      cwd: pluginRoot,
      env,
      timeout: 15_000,
    });

    const marker = await fs.readFile(repairMarker, 'utf8');
    expect(marker).toContain('args=--phase manual --force-reconnect');
    expect(marker).toContain('secret=unset');
    expect(marker).toContain('watchdog=1');

    const savedState = JSON.parse(await fs.readFile(stateFile, 'utf8')) as {
      failureStreak?: number;
      lastRepairAt?: number;
    };
    expect(savedState.failureStreak).toBe(0);
    expect(savedState.lastRepairAt).toBeGreaterThan(0);
  });
});
