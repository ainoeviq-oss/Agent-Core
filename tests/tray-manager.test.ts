import { closeSync, openSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..');
const trayScript = path.join(repoRoot, 'scripts', 'windows', 'agent-core-tray.ps1');
const roots: string[] = [];
const children: ChildProcess[] = [];
const managedConfigs: string[] = [];

async function tempRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-core-tray-'));
  roots.push(root);
  return root;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function writeConfig(root: string, overrides: Record<string, unknown> = {}) {
  const agentCorePort = Number(overrides.agentCorePort ?? await freePort());
  const tunnelPort = Number(overrides.tunnelPort ?? await freePort());
  const config = {
    root,
    trayRuntimeDir: path.join(root, 'runtime', 'tray'),
    agentCorePort,
    tunnelPort,
    nodeExe: process.execPath,
    agentCoreEntry: path.join(root, 'fake-agent-core.mjs'),
    tunnelExe: process.execPath,
    tunnelProfile: path.join(root, 'agent-core.yaml'),
    watchdogIntervalSeconds: 10,
    failureThreshold: 3,
    restartLimit: 3,
    restartWindowSeconds: 300,
    mutexName: `Local\\AgentCoreTrayTest-${path.basename(root)}`,
    ...overrides,
  };
  const configPath = path.join(root, 'tray-config.json');
  await writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
  return { config, configPath };
}

function runTray(mode: string, configPath: string) {
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const stdoutPath = path.join(path.dirname(configPath), `.tray-stdout-${stamp}.txt`);
  const stderrPath = path.join(path.dirname(configPath), `.tray-stderr-${stamp}.txt`);
  const stdoutFd = openSync(stdoutPath, 'w');
  const stderrFd = openSync(stderrPath, 'w');
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', trayScript, '-Mode', mode, '-ConfigPath', configPath,
  ], { cwd: repoRoot, stdio: ['ignore', stdoutFd, stderrFd] });
  closeSync(stdoutFd); closeSync(stderrFd);
  const stdout = readFileSync(stdoutPath, 'utf8');
  const stderr = readFileSync(stderrPath, 'utf8');
  rmSync(stdoutPath, { force: true }); rmSync(stderrPath, { force: true });
  return { ...result, stdout, stderr };
}

function spawnTray(mode: string, configPath: string) {
  const child = spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', trayScript, '-Mode', mode, '-ConfigPath', configPath,
  ], { cwd: repoRoot, stdio: 'ignore' });
  children.push(child);
  return child;
}

async function waitForPort(port: number, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    if (open) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`port ${port} did not open`);
}

async function startFakeServer(scriptPath: string, port: number) {
  await writeFile(scriptPath, [
    "import http from 'node:http';",
    "const port = Number(process.argv[2]);",
    "http.createServer((req,res)=>{",
    "  res.writeHead(200, {'content-type':'application/json'});",
    "  res.end(JSON.stringify({status:'ok'}));",
    "}).listen(port, '127.0.0.1');",
    "setInterval(()=>{}, 1000);",
  ].join('\n'), 'utf8');
  const child = spawn(process.execPath, [scriptPath, String(port)], { stdio: 'ignore' });
  children.push(child);
  await waitForPort(port);
  return child;
}

afterEach(async () => {
  for (const configPath of managedConfigs.splice(0)) runTray('StopBundle', configPath);
  for (const child of children.splice(0)) child.kill();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Agent Core tray lifecycle foundation', () => {
  it('probes isolated config without touching production or leaking ignored fields', async () => {
    const root = await tempRoot();
    const { configPath, config } = await writeConfig(root, { secretSentinel: 'DO_NOT_LEAK_ME' });
    const result = runTray('Probe', configPath);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain('DO_NOT_LEAK_ME');
    const body = JSON.parse(result.stdout.trim());
    expect(body).toMatchObject({
      status: 'ok',
      root,
      agentCorePort: config.agentCorePort,
      tunnelPort: config.tunnelPort,
    });
    expect(body.agentCore.identityMatch).toBe(false);
    expect(body.tunnel.identityMatch).toBe(false);
    expect(result.stdout).not.toContain('8765');
    expect(result.stdout).not.toContain('8787');
  });

  it('accepts identity only when port owner, executable, and command signature all match', async () => {
    const root = await tempRoot();
    const port = await freePort();
    const scriptPath = path.join(root, 'fake-agent-core.mjs');
    const child = await startFakeServer(scriptPath, port);
    const good = await writeConfig(root, { agentCorePort: port, agentCoreEntry: scriptPath });
    const goodBody = JSON.parse(runTray('Probe', good.configPath).stdout.trim());
    expect(goodBody.agentCore).toMatchObject({ pid: child.pid, identityMatch: true });

    const bad = await writeConfig(root, {
      agentCorePort: port,
      agentCoreEntry: path.join(root, 'wrong.mjs'),
    });
    const badBody = JSON.parse(runTray('Probe', bad.configPath).stdout.trim());
    expect(badBody.agentCore).toMatchObject({ pid: child.pid, identityMatch: false });
    expect(child.killed).toBe(false);
  });

  it('discards stale or mismatched state without stopping a live mismatched process', async () => {
    const root = await tempRoot();
    const live = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    children.push(live);
    const { configPath, config } = await writeConfig(root);
    const statePath = path.join(String(config.trayRuntimeDir), 'state.json');
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({
      services: {
        agentCore: { pid: 999999, role: 'agentCore' },
        tunnel: { pid: live.pid, role: 'tunnel' },
      },
    }), 'utf8');

    const result = runTray('Probe', configPath);
    expect(result.status).toBe(0);
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    expect(state.services).toEqual({});
    expect(live.killed).toBe(false);
  });

  it('permits only one tray manager mutex holder per configured identity', async () => {
    const root = await tempRoot();
    const { configPath } = await writeConfig(root, { holdMutexSeconds: 4 });
    const first = spawnTray('Probe', configPath);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(first.exitCode).toBe(null);

    const second = runTray('Probe', configPath);
    expect(second.status).toBe(23);
    expect(JSON.parse(second.stdout.trim())).toMatchObject({ status: 'already_running' });
  });
});


async function waitForPortClosed(port: number, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const closed = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); resolve(false); });
      socket.once('error', () => resolve(true));
    });
    if (closed) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`port ${port} did not close`);
}

async function writeFakeBundle(root: string, tunnelPort: number) {
  const agentCoreEntry = path.join(root, 'fake-agent-core.mjs');
  const tunnelEntry = path.join(root, 'fake-tunnel.mjs');
  const tunnelProfile = path.join(root, 'agent-core.yaml');
  await writeFile(agentCoreEntry, [
    "import http from 'node:http';",
    "const port = Number(process.env.AGENT_CORE_PORT);",
    "http.createServer((req,res)=>{",
    "  if (req.url === '/health') { res.writeHead(200, {'content-type':'application/json'}); return res.end(JSON.stringify({status:'ok',memory:{enabled:true,healthy:true,state:'healthy'},memoryDbPath:process.env.AGENT_CORE_MEMORY_DB_PATH,memoryEnabled:process.env.AGENT_CORE_MEMORY_ENABLED})); }",
    "  res.writeHead(404); res.end('missing');",
    "}).listen(port, '127.0.0.1');",
    "setInterval(()=>{}, 1000);",
  ].join('\n'), 'utf8');
  await writeFile(tunnelEntry, [
    "import http from 'node:http';",
    "import { readFileSync } from 'node:fs';",
    "const args = process.argv.slice(2);",
    "const index = args.indexOf('--profile-file');",
    "const profile = JSON.parse(readFileSync(args[index + 1], 'utf8'));",
    "http.createServer((req,res)=>{",
    "  if (req.url === '/readyz') { res.writeHead(200); return res.end('ready'); }",
    "  res.writeHead(404); res.end('missing');",
    "}).listen(Number(profile.adminPort), '127.0.0.1');",
    "setInterval(()=>{}, 1000);",
  ].join('\n'), 'utf8');
  await writeFile(tunnelProfile, JSON.stringify({ adminPort: tunnelPort }), 'utf8');
  return { agentCoreEntry, tunnelEntry, tunnelProfile };
}

async function startStaleTunnel(scriptPath: string, profilePath: string, port: number) {
  await writeFile(scriptPath, [
    "import http from 'node:http';",
    "const args = process.argv.slice(2);",
    "const port = Number(args[args.indexOf('--port') + 1]);",
    "http.createServer((req,res)=>{ res.writeHead(200); res.end('ready'); }).listen(port, '127.0.0.1');",
    "setInterval(()=>{}, 1000);",
  ].join('\n'), 'utf8');
  const child = spawn(process.execPath, [
    scriptPath, '--profile-file', profilePath, '--port', String(port),
  ], { stdio: 'ignore' });
  children.push(child);
  await waitForPort(port);
  return child;
}

function waitForExit(child: ChildProcess, timeoutMs = 5000) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child did not exit')), timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

const slowLifecycleIt = (name: string, fn: () => Promise<void>) => it(name, fn, 20_000);

describe('Agent Core tray service lifecycle', () => {
  slowLifecycleIt('starts and stops an isolated two-service bundle with owned state', async () => {
    const root = await tempRoot();
    const agentCorePort = await freePort();
    const tunnelPort = await freePort();
    const fake = await writeFakeBundle(root, tunnelPort);
    const { configPath, config } = await writeConfig(root, {
      agentCorePort, tunnelPort,
      agentCoreEntry: fake.agentCoreEntry,
      tunnelEntry: fake.tunnelEntry,
      tunnelProfile: fake.tunnelProfile,
    });
    managedConfigs.push(configPath);

    const started = runTray('StartBundle', configPath);
    expect(started.status).toBe(0);
    expect(JSON.parse(started.stdout.trim()).status).toBe('running');
    await waitForPort(agentCorePort);
    await waitForPort(tunnelPort);
    const launchedHealth = await (await fetch(`http://127.0.0.1:${agentCorePort}/health`)).json() as Record<string, any>;
    expect(launchedHealth.memoryEnabled).toBe('true');
    expect(path.normalize(launchedHealth.memoryDbPath)).toBe(path.normalize(path.join(root, 'runtime', 'memory', 'agent-core-memory.sqlite')));

    const statePath = path.join(String(config.trayRuntimeDir), 'state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    expect(state.services.agentCore.pid).toBeTypeOf('number');
    expect(state.services.tunnel.pid).toBeTypeOf('number');

    const stopped = runTray('StopBundle', configPath);
    expect(stopped.status).toBe(0);
    expect(JSON.parse(stopped.stdout.trim()).status).toBe('stopped');
    managedConfigs.pop();
    await waitForPortClosed(agentCorePort);
    await waitForPortClosed(tunnelPort);
  });

  slowLifecycleIt('marks a mismatched port occupant degraded and never stops or owns it', async () => {
    const root = await tempRoot();
    const agentCorePort = await freePort();
    const tunnelPort = await freePort();
    const conflictScript = path.join(root, 'foreign-server.mjs');
    const foreign = await startFakeServer(conflictScript, agentCorePort);
    const fake = await writeFakeBundle(root, tunnelPort);
    const { configPath, config } = await writeConfig(root, {
      agentCorePort, tunnelPort,
      agentCoreEntry: fake.agentCoreEntry,
      tunnelEntry: fake.tunnelEntry,
      tunnelProfile: fake.tunnelProfile,
    });
    managedConfigs.push(configPath);

    const result = runTray('StartBundle', configPath);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim()).status).toBe('degraded');
    const state = JSON.parse(await readFile(path.join(String(config.trayRuntimeDir), 'state.json'), 'utf8'));
    expect(state.services.agentCore).toBeUndefined();
    expect(foreign.exitCode).toBe(null);
  });

  slowLifecycleIt('controlled takeover adopts a healthy canonical MCP in place without restart', async () => {
    const root = await tempRoot();
    const agentCorePort = await freePort();
    const entry = path.join(root, 'fake-agent-core.mjs');
    const existing = await startFakeServer(entry, agentCorePort);
    const { configPath, config } = await writeConfig(root, { agentCorePort, agentCoreEntry: entry });

    const result = runTray('ControlledTakeover', configPath);
    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout.trim());
    expect(body.agentCore).toMatchObject({ action: 'adopted', pid: existing.pid });
    const state = JSON.parse(await readFile(path.join(String(config.trayRuntimeDir), 'state.json'), 'utf8'));
    expect(state.services.agentCore).toMatchObject({ pid: existing.pid, origin: 'adopted' });
    expect(existing.exitCode).toBe(null);
    managedConfigs.push(configPath);
  });

  slowLifecycleIt('controlled takeover replaces only a validated stale missing-profile tunnel', async () => {
    const root = await tempRoot();
    const tunnelPort = await freePort();
    const staleScript = path.join(root, 'stale-tunnel.mjs');
    const missingProfile = path.join(root, 'removed-profile.yaml');
    const stale = await startStaleTunnel(staleScript, missingProfile, tunnelPort);
    const fake = await writeFakeBundle(root, tunnelPort);
    const { configPath } = await writeConfig(root, {
      tunnelPort,
      tunnelExe: process.execPath,
      tunnelEntry: fake.tunnelEntry,
      tunnelProfile: fake.tunnelProfile,
    });
    managedConfigs.push(configPath);

    const result = runTray('ControlledTakeover', configPath);
    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout.trim());
    expect(body.tunnel.action).toBe('replaced');
    await waitForExit(stale);
    await waitForPort(tunnelPort);
  });

  slowLifecycleIt('controlled takeover refuses a noncanonical tunnel when its profile still exists', async () => {
    const root = await tempRoot();
    const tunnelPort = await freePort();
    const staleScript = path.join(root, 'other-tunnel.mjs');
    const existingProfile = path.join(root, 'other-profile.yaml');
    await writeFile(existingProfile, 'still here', 'utf8');
    const stale = await startStaleTunnel(staleScript, existingProfile, tunnelPort);
    const fake = await writeFakeBundle(root, tunnelPort);
    const { configPath } = await writeConfig(root, {
      tunnelPort,
      tunnelExe: process.execPath,
      tunnelEntry: fake.tunnelEntry,
      tunnelProfile: fake.tunnelProfile,
    });

    const result = runTray('ControlledTakeover', configPath);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim()).tunnel.action).toBe('denied');
    expect(stale.exitCode).toBe(null);
  });
});

async function startProbeServer(root: string, name: string, port: number, kind: string) {
  const scriptPath = path.join(root, `${name}.mjs`);
  await writeFile(scriptPath, [
    "import http from 'node:http';",
    "const port = Number(process.argv[2]); const kind = process.argv[3];",
    "http.createServer((req,res)=>{",
    "  if (kind === 'agent-ok') { res.writeHead(200, {'content-type':'application/json'}); return res.end(JSON.stringify({status:'ok',memory:{enabled:true,healthy:true,state:'healthy'}})); }",
    "  if (kind === 'agent-memory-degraded') { res.writeHead(200, {'content-type':'application/json'}); return res.end(JSON.stringify({status:'ok',memory:{enabled:true,healthy:false,state:'degraded'}})); }",
    "  if (kind === 'agent-malformed') { res.writeHead(200, {'content-type':'application/json'}); return res.end('{bad'); }",
    "  if (kind === 'tunnel-ok') { res.writeHead(200); return res.end('ready'); }",
    "  res.writeHead(503); res.end('unhealthy');",
    "}).listen(port, '127.0.0.1');",
    "setInterval(()=>{}, 1000);",
  ].join('\n'), 'utf8');
  const child = spawn(process.execPath, [scriptPath, String(port), kind], { stdio: 'ignore' });
  children.push(child); await waitForPort(port); return child;
}

const slowWatchdogIt = (name: string, fn: () => Promise<void>) => it(name, fn, 60_000);

describe('Agent Core tray watchdog', () => {  slowWatchdogIt('reports healthy local Agent Core and tunnel probes', async () => {
    const root = await tempRoot();
    const agentCorePort = await freePort();
    const tunnelPort = await freePort();
    await startProbeServer(root, 'agent-health', agentCorePort, 'agent-ok');
    await startProbeServer(root, 'tunnel-health', tunnelPort, 'tunnel-ok');
    const { configPath } = await writeConfig(root, { agentCorePort, tunnelPort });

    const body = JSON.parse(runTray('Probe', configPath).stdout.trim());
    expect(body.agentCore.healthy).toBe(true);
    expect(body.agentCore.memory).toBe('Healthy');
    expect(body.tunnel.healthy).toBe(true);
  });

  slowWatchdogIt('keeps Agent Core healthy while surfacing degraded in-process memory separately', async () => {
    const root = await tempRoot();
    const agentCorePort = await freePort();
    const tunnelPort = await freePort();
    await startProbeServer(root, 'agent-health-degraded-memory', agentCorePort, 'agent-memory-degraded');
    await startProbeServer(root, 'tunnel-health-degraded-memory', tunnelPort, 'tunnel-ok');
    const { configPath } = await writeConfig(root, { agentCorePort, tunnelPort });

    const body = JSON.parse(runTray('Probe', configPath).stdout.trim());
    expect(body.agentCore.healthy).toBe(true);
    expect(body.agentCore.memory).toBe('Degraded');
    expect(body.tunnel.healthy).toBe(true);
  });

  slowWatchdogIt('treats malformed, non-200, and unavailable health endpoints as unhealthy', async () => {
    const root = await tempRoot();
    const agentCorePort = await freePort();
    const tunnelPort = await freePort();
    await startProbeServer(root, 'agent-health', agentCorePort, 'agent-malformed');
    await startProbeServer(root, 'tunnel-health', tunnelPort, 'non200');
    const { configPath } = await writeConfig(root, { agentCorePort, tunnelPort });

    const body = JSON.parse(runTray('Probe', configPath).stdout.trim());
    expect(body.agentCore.healthy).toBe(false);
    expect(body.tunnel.healthy).toBe(false);
  });
  slowWatchdogIt('restarts an owned service only after three consecutive failed probes', async () => {
    const root = await tempRoot();
    const agentCorePort = await freePort(); const tunnelPort = await freePort();
    const fake = await writeFakeBundle(root, tunnelPort);
    const { configPath, config } = await writeConfig(root, {
      agentCorePort, tunnelPort, agentCoreEntry: fake.agentCoreEntry,
      tunnelEntry: fake.tunnelEntry, tunnelProfile: fake.tunnelProfile,
    });
    managedConfigs.push(configPath);
    expect(JSON.parse(runTray('StartBundle', configPath).stdout.trim()).status).toBe('running');
    const statePath = path.join(String(config.trayRuntimeDir), 'state.json');
    const before = JSON.parse(await readFile(statePath, 'utf8'));
    const oldPid = Number(before.services.agentCore.pid);
    process.kill(oldPid); await waitForPortClosed(agentCorePort);

    const tick1 = JSON.parse(runTray('WatchdogTick', configPath).stdout.trim());
    const tick2 = JSON.parse(runTray('WatchdogTick', configPath).stdout.trim());
    expect(tick1.agentCore).toMatchObject({ action: 'none', consecutiveFailures: 1 });
    expect(tick2.agentCore).toMatchObject({ action: 'none', consecutiveFailures: 2 });
    expect(await new Promise<boolean>((resolve) => {
      const s = net.createConnection({host:'127.0.0.1',port:agentCorePort});
      s.once('connect',()=>{s.destroy();resolve(true)}); s.once('error',()=>resolve(false));
    })).toBe(false);    const tick3 = JSON.parse(runTray('WatchdogTick', configPath).stdout.trim());
    expect(tick3.agentCore.action).toBe('restarted');
    await waitForPort(agentCorePort);
    const after = JSON.parse(await readFile(statePath, 'utf8'));
    expect(Number(after.services.agentCore.pid)).not.toBe(oldPid);
    expect(after.services.agentCore.consecutiveFailures).toBe(0);
  });

  slowWatchdogIt('faults after the fourth recovery trigger inside the rolling restart window', async () => {
    const root = await tempRoot();
    const agentCorePort = await freePort(); const tunnelPort = await freePort();
    const fake = await writeFakeBundle(root, tunnelPort);
    const { configPath, config } = await writeConfig(root, {
      agentCorePort, tunnelPort, agentCoreEntry: fake.agentCoreEntry,
      tunnelEntry: fake.tunnelEntry, tunnelProfile: fake.tunnelProfile,
    });
    managedConfigs.push(configPath);
    runTray('StartBundle', configPath);
    const statePath = path.join(String(config.trayRuntimeDir), 'state.json');

    for (let cycle = 0; cycle < 3; cycle++) {
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      process.kill(Number(state.services.agentCore.pid)); await waitForPortClosed(agentCorePort);
      runTray('WatchdogTick', configPath); runTray('WatchdogTick', configPath);
      const third = JSON.parse(runTray('WatchdogTick', configPath).stdout.trim());
      expect(third.agentCore.action).toBe('restarted'); await waitForPort(agentCorePort);
    }    const state = JSON.parse(await readFile(statePath, 'utf8'));
    process.kill(Number(state.services.agentCore.pid)); await waitForPortClosed(agentCorePort);
    runTray('WatchdogTick', configPath); runTray('WatchdogTick', configPath);
    const blocked = JSON.parse(runTray('WatchdogTick', configPath).stdout.trim());
    expect(blocked.agentCore).toMatchObject({ action: 'faulted', healthState: 'Faulted' });
    await expect(waitForPort(agentCorePort, 800)).rejects.toThrow();
    const finalState = JSON.parse(await readFile(statePath, 'utf8'));
    expect(finalState.services.agentCore.restartHistory).toHaveLength(3);
  });

  slowWatchdogIt('manual RestartBundle clears fault counters and restart history', async () => {
    const root = await tempRoot();
    const agentCorePort = await freePort(); const tunnelPort = await freePort();
    const fake = await writeFakeBundle(root, tunnelPort);
    const { configPath, config } = await writeConfig(root, {
      agentCorePort, tunnelPort, agentCoreEntry: fake.agentCoreEntry,
      tunnelEntry: fake.tunnelEntry, tunnelProfile: fake.tunnelProfile,
    });
    managedConfigs.push(configPath); runTray('StartBundle', configPath);
    const statePath = path.join(String(config.trayRuntimeDir), 'state.json');
    const seeded = JSON.parse(await readFile(statePath, 'utf8'));
    seeded.services.agentCore.healthState = 'Faulted'; seeded.services.agentCore.consecutiveFailures = 9;
    seeded.services.agentCore.restartHistory = [Date.now()-3000, Date.now()-2000, Date.now()-1000];
    await writeFile(statePath, JSON.stringify(seeded, null, 2), 'utf8');

    expect(JSON.parse(runTray('RestartBundle', configPath).stdout.trim()).status).toBe('running');
    const after = JSON.parse(await readFile(statePath, 'utf8'));
    expect(after.services.agentCore.healthState).toBe('Running');
    expect(after.services.agentCore.consecutiveFailures).toBe(0);
    expect(after.services.agentCore.restartHistory).toEqual([]);
  });
});
// Health probes also need an explicit no-listener regression case.
describe('Agent Core tray watchdog unavailable endpoints', () => {
  slowWatchdogIt('reports unavailable Agent Core and tunnel endpoints as unhealthy', async () => {
    const root = await tempRoot();
    const agentCorePort = await freePort(); const tunnelPort = await freePort();
    const { configPath } = await writeConfig(root, { agentCorePort, tunnelPort });
    const body = JSON.parse(runTray('Probe', configPath).stdout.trim());
    expect(body.agentCore.healthy).toBe(false);
    expect(body.tunnel.healthy).toBe(false);
  });
});

describe('Agent Core tray UI contract', () => {
  it('declares the native tray menu, watchdog timer, and lifecycle-only callbacks', () => {
    const source = readFileSync(trayScript, 'utf8');
    for (const label of [
      'Agent Core',
      'MCP Server:',
      'Tunnel:',
      'Open Agent Core Folder',
      'Open Tunnel Admin UI',
      'Restart Agent Core',
      'Restart Tunnel',
      'Restart All',
      'Start with Windows:',
      'Exit Agent Core',
    ]) expect(source).toContain(label);
    expect(source).toContain('Memory:');
    expect(source).toContain('System.Windows.Forms.NotifyIcon');
    expect(source).toContain('System.Windows.Forms.Timer');
    expect(source).toContain('Invoke-WatchdogTick');
    expect(source).toContain('Invoke-TrayExit');
  });

  slowLifecycleIt('uses the tray exit callback to suspend watchdog and stop both owned services', async () => {
    const root = await tempRoot();
    const agentCorePort = await freePort();
    const tunnelPort = await freePort();
    const fake = await writeFakeBundle(root, tunnelPort);
    const { configPath, config } = await writeConfig(root, {
      agentCorePort, tunnelPort,
      agentCoreEntry: fake.agentCoreEntry,
      tunnelEntry: fake.tunnelEntry,
      tunnelProfile: fake.tunnelProfile,
    });
    managedConfigs.push(configPath);
    expect(JSON.parse(runTray('StartBundle', configPath).stdout.trim()).status).toBe('running');

    const exited = runTray('TrayExit', configPath);
    expect(exited.status).toBe(0);
    expect(JSON.parse(exited.stdout.trim())).toMatchObject({
      status: 'exited',
      watchdogSuspended: true,
    });
    managedConfigs.pop();
    await waitForPortClosed(agentCorePort);
    await waitForPortClosed(tunnelPort);
    const state = JSON.parse(await readFile(path.join(String(config.trayRuntimeDir), 'state.json'), 'utf8'));
    expect(state.services).toEqual({});
  });
});


describe('Agent Core tray deployment defaults', () => {
  it('discovers the tunnel client independently from the Agent Core project drive', () => {
    const source = readFileSync(trayScript, 'utf8');
    expect(source).toContain('AGENT_CORE_TUNNEL_EXE');
    expect(source).toContain('Get-PSDrive');
    expect(source).not.toContain('[IO.Path]::GetPathRoot($root)');
    expect(source).toContain('AGENT_CORE_MEMORY_ENABLED');
    expect(source).toContain('AGENT_CORE_MEMORY_DB_PATH');
    expect(source).toContain("runtime\\memory\\agent-core-memory.sqlite");
  });
});


describe('Agent Core tray production command signatures', () => {
  slowLifecycleIt('adopts a healthy Agent Core listener started with the canonical entry path relative to the repo root', async () => {
    const root = await tempRoot();
    const agentCorePort = await freePort();
    const entry = path.join(root, 'dist', 'index.js');
    await mkdir(path.dirname(entry), { recursive: true });
    await writeFile(entry, [
      "import http from 'node:http';",
      "const port = Number(process.argv[2]);",
      "http.createServer((req,res)=>{ res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({status:'ok'})); }).listen(port, '127.0.0.1');",
      "setInterval(()=>{}, 1000);",
    ].join('\n'), 'utf8');
    const existing = spawn(process.execPath, ['dist/index.js', String(agentCorePort)], { cwd: root, stdio: 'ignore' });
    children.push(existing);
    await waitForPort(agentCorePort);
    const { configPath, config } = await writeConfig(root, { agentCorePort, agentCoreEntry: entry });

    const result = runTray('ControlledTakeover', configPath);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim()).agentCore).toMatchObject({ action: 'adopted', pid: existing.pid });
    const state = JSON.parse(await readFile(path.join(String(config.trayRuntimeDir), 'state.json'), 'utf8'));
    expect(state.services.agentCore).toMatchObject({ pid: existing.pid, origin: 'adopted' });
    expect(existing.exitCode).toBe(null);
    managedConfigs.push(configPath);
  });
});

describe('Agent Core tray OAuth re-auth action', () => {
  it('runs reset-oauth against canonical runtime data and restarts Agent Core', async () => {
    const root = await tempRoot();
    const agentCorePort = await freePort();
    const tunnelPort = await freePort();
    const fake = await writeFakeBundle(root, tunnelPort);
    const fakeCli = path.join(root, 'fake-cli.mjs');
    await writeFile(fakeCli, [
      "const args = process.argv.slice(2);",
      "console.log(JSON.stringify({args, dataDir: process.env.AGENT_CORE_DATA_DIR}));",
    ].join('\n'), 'utf8');
    const { configPath } = await writeConfig(root, {
      agentCorePort, tunnelPort, agentCoreEntry: fake.agentCoreEntry, agentCoreCli: fakeCli,
    });
    managedConfigs.push(configPath);

    const result = runTray('ResetOAuth', configPath);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const body = JSON.parse(result.stdout.trim());
    expect(body.status).toBe('ready_for_reauth');
    expect(body.oauthReset.args).toEqual(['reset-oauth', path.join(root, 'runtime', 'data-current')]);
    expect(path.normalize(body.oauthReset.dataDir)).toBe(path.normalize(path.join(root, 'runtime', 'data')));
    expect(body.agentCore.ok).toBe(true);
    await waitForPort(agentCorePort);
  }, 20_000);

  it('exposes Reset OAuth / Re-auth in the tray menu', () => {
    const source = readFileSync(trayScript, 'utf8');
    expect(source).toContain('Reset OAuth / Re-auth');
    expect(source).toContain("'ResetOAuth'");
    expect(source).toContain("'reset-oauth'");
  });
});
