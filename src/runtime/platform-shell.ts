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
    return {
      executable: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
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
