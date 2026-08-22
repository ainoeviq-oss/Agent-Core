import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { WorkspacePolicy } from './workspace.js';

const BLOCKED = new Set([
  'mkfs', 'format', 'mount', 'umount', 'fdisk', 'dd', 'parted', 'diskpart',
  'sudo', 'su', 'passwd', 'adduser', 'useradd', 'usermod', 'groupadd', 'chsh', 'visudo',
  'shutdown', 'reboot', 'halt', 'poweroff', 'init', 'iptables', 'firewall', 'netsh',
  'sfc', 'bcdedit', 'reg', 'net', 'sc', 'runas', 'cipher', 'takeown',
]);

const MAX_OUTPUT_BYTES = 256 * 1024;

export interface ExecuteOptions { cwd: string; timeoutMs?: number }
export interface StartOptions { cwd: string }
export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputTruncated: boolean;
}

interface Session {
  sessionId: string;
  command: string;
  cwd: string;
  child: ChildProcessWithoutNullStreams;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: string;
  exited: boolean;
}

function commandName(segment: string): string {
  return (segment.trim().replace(/^&\s*/, '').match(/^([A-Za-z0-9_.-]+)/)?.[1] ?? '').replace(/\.exe$/i, '').toLowerCase();
}

function assertCommandAllowed(command: string): void {
  const segments = command.split(/(?:;|&&|\|\|?|\r?\n)+/);
  for (const segment of segments) {
    const executable = commandName(segment);
    if (BLOCKED.has(executable)) throw new Error(`Blocked command: ${executable}`);
    const nested = segment.match(/(?:cmd(?:\.exe)?\s+\/c|powershell(?:\.exe)?[^\r\n]*?-command|start-process)\s+["']?([A-Za-z0-9_.-]+)/i)?.[1];
    if (nested && BLOCKED.has(nested.replace(/\.exe$/i, '').toLowerCase())) {
      throw new Error(`Blocked command: ${nested}`);
    }
  }
}

function appendBounded(current: string, chunk: Buffer, state: { truncated: boolean }): string {
  const combined = Buffer.concat([Buffer.from(current, 'utf8'), chunk]);
  if (combined.length <= MAX_OUTPUT_BYTES) return combined.toString('utf8');
  state.truncated = true;
  return combined.subarray(combined.length - MAX_OUTPUT_BYTES).toString('utf8');
}

function spawnPowerShell(command: string, cwd: string): ChildProcessWithoutNullStreams {
  return spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    cwd,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export class ProcessManager {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly workspace: WorkspacePolicy) {}

  async execute(command: string, options: ExecuteOptions): Promise<ProcessResult> {
    assertCommandAllowed(command);
    const cwd = await this.workspace.resolveExisting(options.cwd);
    const child = spawnPowerShell(command, cwd);
    let stdout = '';
    let stderr = '';
    const outputState = { truncated: false };
    let timedOut = false;

    child.stdout.on('data', (chunk: Buffer) => { stdout = appendBounded(stdout, chunk, outputState); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = appendBounded(stderr, chunk, outputState); });

    const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 30_000, 10 * 60_000));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    return await new Promise<ProcessResult>((resolve, reject) => {
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code, stdout, stderr, timedOut, outputTruncated: outputState.truncated });
      });
    });
  }

  async start(command: string, options: StartOptions): Promise<{ sessionId: string; pid: number | null; cwd: string }> {
    assertCommandAllowed(command);
    const cwd = await this.workspace.resolveExisting(options.cwd);
    const child = spawnPowerShell(command, cwd);
    const sessionId = `proc_${randomUUID()}`;
    const session: Session = {
      sessionId,
      command,
      cwd,
      child,
      stdout: '',
      stderr: '',
      outputTruncated: false,
      exitCode: null,
      signal: null,
      startedAt: new Date().toISOString(),
      exited: false,
    };
    this.sessions.set(sessionId, session);

    child.stdout.on('data', (chunk: Buffer) => {
      const state = { truncated: session.outputTruncated };
      session.stdout = appendBounded(session.stdout, chunk, state);
      session.outputTruncated = state.truncated;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const state = { truncated: session.outputTruncated };
      session.stderr = appendBounded(session.stderr, chunk, state);
      session.outputTruncated = state.truncated;
    });
    child.once('error', (error) => {
      session.stderr += `${error.message}\n`;
      session.exited = true;
    });
    child.once('exit', (code, signal) => {
      session.exitCode = code;
      session.signal = signal;
      session.exited = true;
    });

    await new Promise<void>((resolve) => {
      if (session.stdout || session.stderr || session.exited) return resolve();
      const timer = setTimeout(resolve, 750);
      const done = () => { clearTimeout(timer); resolve(); };
      child.stdout.once('data', done);
      child.stderr.once('data', done);
      child.once('exit', done);
      child.once('error', done);
    });

    return { sessionId, pid: child.pid ?? null, cwd };
  }

  read(sessionId: string): { sessionId: string; stdout: string; stderr: string; running: boolean; exitCode: number | null; outputTruncated: boolean } {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown process session: ${sessionId}`);
    return {
      sessionId,
      stdout: session.stdout,
      stderr: session.stderr,
      running: !session.exited,
      exitCode: session.exitCode,
      outputTruncated: session.outputTruncated,
    };
  }

  list(): Array<{ sessionId: string; pid: number | null; command: string; cwd: string; running: boolean; exitCode: number | null; startedAt: string }> {
    return [...this.sessions.values()].map((session) => ({
      sessionId: session.sessionId,
      pid: session.child.pid ?? null,
      command: session.command,
      cwd: session.cwd,
      running: !session.exited,
      exitCode: session.exitCode,
      startedAt: session.startedAt,
    }));
  }

  async stop(sessionId: string): Promise<{ sessionId: string; stopped: boolean }> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown process session: ${sessionId}`);
    if (session.exited) return { sessionId, stopped: true };

    session.child.kill();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 750);
      session.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    if (!session.exited) session.child.kill('SIGKILL');
    return { sessionId, stopped: true };
  }
}

export { assertCommandAllowed };
