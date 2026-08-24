import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..');
const windowsDir = path.join(repoRoot, 'scripts', 'windows');
const installPs1 = path.join(windowsDir, 'install-agent-core-autostart.ps1');
const uninstallPs1 = path.join(windowsDir, 'uninstall-agent-core-autostart.ps1');
const trayScript = path.join(windowsDir, 'agent-core-tray.ps1');
const launcherScript = path.join(windowsDir, 'agent-core-launcher.ps1');

function runPowerShellFile(file: string, args: string[] = []) {
  return spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args,
  ], { cwd: repoRoot, encoding: 'utf8' });
}

describe('Agent Core portable autostart contract', () => {
  it('uses a stable LocalAppData shim instead of storing the project path in Scheduled Tasks', () => {
    expect(existsSync(installPs1)).toBe(true);
    const result = runPowerShellFile(installPs1, ['-ContractOnly']);
    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout.trim());
    expect(body.taskName).toBe('Agent Core Tray Manager');
    expect(body.executable.toLowerCase()).toBe('powershell.exe');
    expect(body.arguments).toContain('launch-current.ps1');
    expect(body.arguments).not.toContain(repoRoot);
    expect(body.locatorRootFile).toContain(path.join('AgentCore', 'root.txt'));
    expect(body.trigger).toBe('AtLogOn');
    expect(body.logonType).toBe('Interactive');
    expect(body.runLevel).toBe('Limited');
  });

  it('writes a root pointer and stable shim, while the unified launcher refreshes the pointer after relocation', () => {
    const installer = readFileSync(installPs1, 'utf8');
    const launcher = readFileSync(launcherScript, 'utf8');
    expect(installer).toContain('LOCALAPPDATA');
    expect(installer).toContain('root.txt');
    expect(installer).toContain('launch-current.ps1');
    expect(installer).toContain('Register-ScheduledTask');
    expect(launcher).toContain('root.txt');
    expect(launcher).toMatch(/Test-Path[^\r\n]*\$locatorRootFile/i);
    expect(launcher).toMatch(/WriteAllText\(\$locatorRootFile/i);
  });

  it('keeps autostart removal separate from Agent Core runtime and custom key data', () => {
    expect(existsSync(uninstallPs1)).toBe(true);
    const source = readFileSync(uninstallPs1, 'utf8');
    expect(source).toContain('Unregister-ScheduledTask');
    expect(source).not.toMatch(/runtime[\\/]data/i);
    expect(source).not.toMatch(/secrets/i);
  });
});

describe('Agent Core portable executable discovery', () => {
  it('lets the tray resolve Node and tunnel without a fixed project drive', () => {
    const source = readFileSync(trayScript, 'utf8');
    expect(source).toContain('AGENT_CORE_NODE_EXE');
    expect(source).toContain('AGENT_CORE_TUNNEL_EXE');
    expect(source).toContain('Get-PSDrive');
    expect(source).not.toMatch(/tunnelExe\s*=\s*'F:\\/i);
    expect(source).not.toMatch(/tunnelExe\s*=\s*'E:\\/i);
  });
});

