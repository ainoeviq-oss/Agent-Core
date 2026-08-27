import { describe, expect, it } from 'vitest';
import { resolveShellInvocation } from '../src/runtime/platform-shell.js';

describe('resolveShellInvocation', () => {
  it('uses PowerShell on Windows and preserves an exact native-command exit code', () => {
    const invocation = resolveShellInvocation('Write-Output hello', 'win32');
    expect(invocation.executable).toBe('powershell.exe');
    expect(invocation.args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
    expect(invocation.args[4]).toContain('Write-Output hello');
    expect(invocation.args[4]).toContain('$global:LASTEXITCODE = $null');
    expect(invocation.args[4]).toContain('exit $global:LASTEXITCODE');
    expect(invocation.windowsHide).toBe(true);
  });

  it('uses bash login-command mode on Linux', () => {
    expect(resolveShellInvocation('printf "hello\\n"', 'linux')).toEqual({
      executable: '/bin/bash',
      args: ['-lc', 'printf "hello\\n"'],
      windowsHide: false,
    });
  });

  it('rejects unsupported platforms rather than guessing a shell', () => {
    expect(() => resolveShellInvocation('echo hello', 'aix')).toThrow(
      'Unsupported Agent Core command platform: aix',
    );
  });
});
