import { describe, expect, it } from 'vitest';
import { resolveShellInvocation } from '../src/runtime/platform-shell.js';

describe('resolveShellInvocation', () => {
  it('uses PowerShell on Windows without changing the existing argument contract', () => {
    expect(resolveShellInvocation('Write-Output hello', 'win32')).toEqual({
      executable: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Write-Output hello'],
      windowsHide: true,
    });
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
