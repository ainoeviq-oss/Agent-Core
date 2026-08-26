import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolveShellInvocation } from './platform-shell.js';
import type { WorkspacePolicy } from './workspace.js';

const BLOCKED = new Set([
  'mkfs', 'format', 'mount', 'umount', 'fdisk', 'dd', 'parted', 'diskpart',
  'sudo', 'su', 'passwd', 'adduser', 'useradd', 'usermod', 'groupadd', 'chsh', 'visudo',
  'shutdown', 'reboot', 'halt', 'poweroff', 'init', 'iptables', 'firewall', 'netsh',
  'sfc', 'bcdedit', 'reg', 'net', 'sc', 'runas', 'cipher', 'takeown',
]);

const MAX_OUTPUT_BYTES = 256 * 1024;

export interface ProcessSessionOwner {
  principalId: string;
  projectId?: string;
  originRouteContextId?: string;
}

export interface ProcessTerminalSnapshot {
  sessionId: string;
  pid: number | null;
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  running: false;
  outputTruncated: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  startedAt: string;
  finishedAt: string;
}

export interface ExecuteOptions { cwd: string; timeoutMs?: number }
export interface StartOptions {
  cwd: string;
  owner?: ProcessSessionOwner;
  onTerminal?: (snapshot: ProcessTerminalSnapshot) => void | Promise<void>;
}
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
  owner?: ProcessSessionOwner;
  child: ChildProcessWithoutNullStreams;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: string;
  finishedAt?: string;
  exited: boolean;
  terminalNotified: boolean;
  terminalEvidence?: Promise<void>;
  onTerminal?: (snapshot: ProcessTerminalSnapshot) => void | Promise<void>;
}

export class ProcessSessionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ProcessSessionError';
  }
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

function spawnCommand(command: string, cwd: string): ChildProcessWithoutNullStreams {
  const invocation = resolveShellInvocation(command);
  return spawn(invocation.executable, invocation.args, {
    cwd,
    windowsHide: invocation.windowsHide,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function normalizeOwner(owner: ProcessSessionOwner | undefined): ProcessSessionOwner | undefined {
  if (!owner) return undefined;
  const principalId = owner.principalId?.trim();
  if (!principalId) throw new ProcessSessionError('PROCESS_OWNER_INVALID', 'Process owner principalId is required');
  const projectId = owner.projectId?.trim() || undefined;
  const originRouteContextId = owner.originRouteContextId?.trim() || undefined;
  return { principalId, ...(projectId ? { projectId } : {}), ...(originRouteContextId ? { originRouteContextId } : {}) };
}

function sameOwner(actual: ProcessSessionOwner, requested: ProcessSessionOwner): boolean {
  return actual.principalId === requested.principalId && (actual.projectId ?? '') === (requested.projectId ?? '');
}

export class ProcessManager {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly workspace: WorkspacePolicy) {}

  async execute(command: string, options: ExecuteOptions): Promise<ProcessResult> {
    assertCommandAllowed(command);
    const cwd = await this.workspace.resolveExisting(options.cwd);
    const child = spawnCommand(command, cwd);
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
    const owner = normalizeOwner(options.owner);
    const child = spawnCommand(command, cwd);
    const sessionId = `proc_${randomUUID()}`;
    const session: Session = {
      sessionId,
      command,
      cwd,
      ...(owner ? { owner } : {}),
      child,
      stdout: '',
      stderr: '',
      outputTruncated: false,
      exitCode: null,
      signal: null,
      startedAt: new Date().toISOString(),
      exited: false,
      terminalNotified: false,
      ...(options.onTerminal ? { onTerminal: options.onTerminal } : {}),
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
      session.finishedAt = new Date().toISOString();
      this.notifyTerminal(session);
    });
    child.once('exit', (code, signal) => {
      session.exitCode = code;
      session.signal = signal;
      session.exited = true;
      session.finishedAt = new Date().toISOString();
      this.notifyTerminal(session);
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

  sessionContext(sessionId: string, owner?: ProcessSessionOwner): ProcessSessionOwner {
    const session = this.requireSession(sessionId, owner);
    if (!session.owner) throw new ProcessSessionError('PROCESS_SESSION_OWNER_MISSING', 'Process session has no stored owner');
    return { ...session.owner };
  }

  read(sessionId: string, owner?: ProcessSessionOwner): { sessionId: string; stdout: string; stderr: string; running: boolean; exitCode: number | null; outputTruncated: boolean } {
    const session = this.requireSession(sessionId, owner);
    return {
      sessionId,
      stdout: session.stdout,
      stderr: session.stderr,
      running: !session.exited,
      exitCode: session.exitCode,
      outputTruncated: session.outputTruncated,
    };
  }

  list(owner?: ProcessSessionOwner): Array<{ sessionId: string; pid: number | null; command: string; cwd: string; running: boolean; exitCode: number | null; startedAt: string }> {
    const requested = owner ? normalizeOwner(owner)! : undefined;
    return [...this.sessions.values()]
      .filter((session) => !requested || (!!session.owner && sameOwner(session.owner, requested)))
      .map((session) => ({
        sessionId: session.sessionId,
        pid: session.child.pid ?? null,
        command: session.command,
        cwd: session.cwd,
        running: !session.exited,
        exitCode: session.exitCode,
        startedAt: session.startedAt,
      }));
  }

  async stop(sessionId: string, owner?: ProcessSessionOwner): Promise<{ sessionId: string; stopped: boolean }> {
    const session = this.requireSession(sessionId, owner);
    if (session.exited) return { sessionId, stopped: true };

    session.child.kill();
    await this.waitForExit(session, 750);
    if (!session.exited) {
      session.child.kill('SIGKILL');
      await this.waitForExit(session, 750);
    }
    if (session.terminalEvidence) await session.terminalEvidence;
    return { sessionId, stopped: true };
  }

  private requireSession(sessionId: string, owner?: ProcessSessionOwner): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw new ProcessSessionError('PROCESS_SESSION_NOT_FOUND', 'Process session was not found');
    if (owner) {
      const requested = normalizeOwner(owner)!;
      if (!session.owner || !sameOwner(session.owner, requested)) {
        throw new ProcessSessionError('PROCESS_SESSION_NOT_FOUND', 'Process session was not found');
      }
    }
    return session;
  }

  private async waitForExit(session: Session, timeoutMs: number): Promise<void> {
    if (session.exited) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      session.child.once('exit', () => { clearTimeout(timer); resolve(); });
      session.child.once('error', () => { clearTimeout(timer); resolve(); });
    });
  }

  private notifyTerminal(session: Session): void {
    if (session.terminalNotified || !session.exited) return;
    session.terminalNotified = true;
    if (!session.onTerminal) return;
    const snapshot: ProcessTerminalSnapshot = {
      sessionId: session.sessionId,
      pid: session.child.pid ?? null,
      cwd: session.cwd,
      exitCode: session.exitCode,
      signal: session.signal,
      running: false,
      outputTruncated: session.outputTruncated,
      stdoutBytes: Buffer.byteLength(session.stdout, 'utf8'),
      stderrBytes: Buffer.byteLength(session.stderr, 'utf8'),
      startedAt: session.startedAt,
      finishedAt: session.finishedAt ?? new Date().toISOString(),
    };
    try {
      session.terminalEvidence = Promise.resolve(session.onTerminal(snapshot))
        .then(() => undefined)
        .catch(() => undefined);
    } catch {
      session.terminalEvidence = Promise.resolve();
      // Terminal evidence callbacks are best-effort and must not alter process lifecycle.
    }
  }
}

export { assertCommandAllowed };
