import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const windowsIt = process.platform === 'win32' ? it : it.skip;
const repoRoot = path.resolve(import.meta.dirname, '..');
const batPath = path.join(repoRoot, 'Start-Agent-Core.bat');
const launcherPath = path.join(repoRoot, 'scripts', 'windows', 'agent-core-launcher.ps1');

function runContract(script: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', script, '-ContractOnly',
  ], { encoding: 'utf8', env: { ...process.env, ...env } });
}

describe('Agent Core unified launcher', () => {
  it('keeps Start-Agent-Core.bat as a thin single public entrypoint', () => {
    expect(existsSync(batPath)).toBe(true);
    const source = readFileSync(batPath, 'utf8');
    expect(source).toContain('%~dp0');
    expect(source).toContain('agent-core-launcher.ps1');
    const launcher = readFileSync(launcherPath, 'utf8');
    expect(launcher).toContain('ControlledTakeover');
    expect(source).not.toMatch(/node\s+dist[\\/]index\.js/i);
    expect(source).not.toMatch(/git\s+-C/i);
    expect(source).not.toMatch(/[A-Z]:\\Projects\\Agent-Core/i);
  });

  windowsIt('reports a script-relative portable contract without changing runtime state', () => {
    expect(existsSync(launcherPath)).toBe(true);
    const result = runContract(launcherPath);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const body = JSON.parse(result.stdout.trim());
    expect(path.resolve(body.root)).toBe(repoRoot);
    expect(path.resolve(body.trayScript)).toBe(path.join(repoRoot, 'scripts', 'windows', 'agent-core-tray.ps1'));
    expect(path.resolve(body.tunnelProfile)).toBe(path.join(repoRoot, 'tunnel-client', 'agent-core.yaml'));
    expect(path.resolve(body.dataDir)).toBe(path.join(repoRoot, 'runtime', 'data'));
    expect(body.launchMode).toBe('background-tray-bundle');
  });

  windowsIt('rebinds root-derived paths when the launcher directory is relocated', () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'agent-core-relocated-'));
    try {
      const windowsDir = path.join(temp, 'scripts', 'windows');
      mkdirSync(windowsDir, { recursive: true });
      const relocated = path.join(windowsDir, 'agent-core-launcher.ps1');
      copyFileSync(launcherPath, relocated);
      const result = runContract(relocated, {
        AGENT_CORE_TUNNEL_EXE: process.execPath,
        AGENT_CORE_NODE_EXE: process.execPath,
      });
      expect(result.status).toBe(0);
      const body = JSON.parse(result.stdout.trim());
      expect(path.resolve(body.root)).toBe(temp);
      expect(path.resolve(body.dataDir)).toBe(path.join(temp, 'runtime', 'data'));
      expect(path.resolve(body.tunnelProfile)).toBe(path.join(temp, 'tunnel-client', 'agent-core.yaml'));
      expect(path.resolve(body.tunnelExe)).toBe(path.resolve(process.execPath));
      expect(path.resolve(body.nodeExe)).toBe(path.resolve(process.execPath));
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});

describe('Agent Core portable tunnel profile', () => {
  it('keeps tunnel secret references portable across project moves', () => {
    const templatePath = path.join(repoRoot, 'tunnel-client', 'agent-core.example.yaml');
    expect(existsSync(templatePath)).toBe(true);

    const profiles = [readFileSync(templatePath, 'utf8')];
    const operatorProfilePath = path.join(repoRoot, 'tunnel-client', 'agent-core.yaml');
    if (existsSync(operatorProfilePath)) {
      profiles.push(readFileSync(operatorProfilePath, 'utf8'));
    }

    for (const profile of profiles) {
      expect(profile).toContain('file:secrets/control-plane-api-key-restored.txt');
      expect(profile).not.toMatch(/file:[A-Z]:[\\/]/i);
    }
  });
});

