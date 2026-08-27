export interface ShellInvocation {
  executable: string;
  args: string[];
  windowsHide: boolean;
}

export function resolveShellInvocation(
  command: string,
  platform: NodeJS.Platform = process.platform,
): ShellInvocation {
  if (platform === 'win32') {
    const wrapped = [
      '$global:LASTEXITCODE = $null',
      command,
      '$agentCoreCommandSucceeded = $?',
      'if ($null -ne $global:LASTEXITCODE) { exit $global:LASTEXITCODE }',
      'if ($agentCoreCommandSucceeded) { exit 0 } else { exit 1 }',
    ].join('; ');
    return {
      executable: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', wrapped],
      windowsHide: true,
    };
  }

  if (platform === 'linux') {
    return {
      executable: '/bin/bash',
      args: ['-lc', command],
      windowsHide: false,
    };
  }

  throw new Error(`Unsupported Agent Core command platform: ${platform}`);
}
