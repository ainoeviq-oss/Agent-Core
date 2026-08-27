import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function commandExists(name: string): Promise<boolean> {
  try {
    await execFileAsync('/usr/bin/which', [name], { timeout: 3000 });
    return true;
  } catch { return false; }
}

export interface KeynoteDoctorResult {
  platform: string;
  available: boolean;
  keynoteInstalled: boolean;
  osascriptAvailable: boolean;
  sdefAvailable: boolean;
  version?: string;
  scriptingSaveCommand?: boolean;
  reason?: string;
}

export async function keynoteDoctor(): Promise<KeynoteDoctorResult> {
  if (process.platform !== 'darwin') {
    return {
      platform: process.platform,
      available: false,
      keynoteInstalled: false,
      osascriptAvailable: false,
      sdefAvailable: false,
      reason: 'Keynote native conversion requires macOS.'
    };
  }

  const keynoteInstalled = await exists('/Applications/Keynote.app');
  const osascriptAvailable = await commandExists('osascript');
  const sdefAvailable = await commandExists('sdef');
  if (!keynoteInstalled || !osascriptAvailable) {
    return {
      platform: process.platform,
      available: false,
      keynoteInstalled,
      osascriptAvailable,
      sdefAvailable,
      reason: 'Keynote.app and osascript are required.'
    };
  }

  let version: string | undefined;
  let scriptingSaveCommand: boolean | undefined;
  try {
    const response = await execFileAsync('/usr/bin/osascript', ['-e', 'tell application "Keynote" to get version'], { timeout: 10_000 });
    version = response.stdout.trim();
  } catch {
    return {
      platform: process.platform,
      available: false,
      keynoteInstalled,
      osascriptAvailable,
      sdefAvailable,
      reason: 'Keynote exists but automation could not query the application version. Check macOS Automation permissions.'
    };
  }

  if (sdefAvailable) {
    try {
      const response = await execFileAsync('/usr/bin/sdef', ['/Applications/Keynote.app'], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
      scriptingSaveCommand = /<command\s+name="save"/i.test(response.stdout) || /code="coresave"/i.test(response.stdout);
    } catch {
      scriptingSaveCommand = false;
    }
  }

  return {
    platform: process.platform,
    available: true,
    keynoteInstalled,
    osascriptAvailable,
    sdefAvailable,
    ...(version ? { version } : {}),
    ...(scriptingSaveCommand !== undefined ? { scriptingSaveCommand } : {})
  };
}
