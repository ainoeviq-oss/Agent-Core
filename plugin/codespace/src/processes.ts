import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { MAX_COMMAND_OUTPUT_BYTES, sanitizeEnvironment } from './constants.js';
import { CodespaceError } from './errors.js';
import { resolveExistingPath } from './workspace.js';

export interface StartProcessInput {
  command: string;
  cwd?: string;
}

export interface ProcessRecord {
  sessionId: string;
  pid: number;
  command: string;
  cwd: string;
  startedAt: number;
  terminalAt: number | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdoutPath: string;
  stderrPath: string;
}

interface OwnedSession {
  record: ProcessRecord;
  child?: ChildProcess;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function terminateOwned(record: ProcessRecord, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== 'win32') {
      process.kill(-record.pid, signal);
    } else {
      process.kill(record.pid, signal);
    }
  } catch {
    // The owned process may already be terminal.
  }
}

async function readTail(filePath: string, maxBytes: number) {
  try {
    const stat = await fsp.stat(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const length = Math.min(stat.size, maxBytes);
    const handle = await fsp.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      if (length > 0) await handle.read(buffer, 0, length, start);
      return { text: buffer.toString('utf8'), truncated: stat.size > maxBytes };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: '', truncated: false };
    throw error;
  }
}

export class ProcessManager {
  private readonly sessions = new Map<string, OwnedSession>();
  private readonly processesDir: string;

  constructor(
    private readonly root: string,
    private readonly runtimeDir: string,
    private readonly allowedBase?: string,
  ) {
    this.processesDir = path.join(runtimeDir, 'processes');
  }

  private metadataPath(sessionId: string): string {
    return path.join(this.processesDir, `${sessionId}.json`);
  }

  private async persist(record: ProcessRecord): Promise<void> {
    await fsp.mkdir(this.processesDir, { recursive: true });
    await fsp.writeFile(this.metadataPath(record.sessionId), `${JSON.stringify(record)}\n`, 'utf8');
  }

  async start(input: StartProcessInput): Promise<ProcessRecord> {
    const cwd = await resolveExistingPath(this.root, input.cwd ?? '.', this.allowedBase);
    await fsp.mkdir(this.processesDir, { recursive: true });

    const sessionId = randomUUID();
    const stdoutPath = path.join(this.processesDir, `${sessionId}.stdout.log`);
    const stderrPath = path.join(this.processesDir, `${sessionId}.stderr.log`);
    const stdout = fs.createWriteStream(stdoutPath, { flags: 'a' });
    const stderr = fs.createWriteStream(stderrPath, { flags: 'a' });
    const child = spawn('/bin/bash', ['-lc', input.command], {
      cwd,
      env: sanitizeEnvironment(),
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (!child.pid) {
      stdout.destroy();
      stderr.destroy();
      throw new CodespaceError('PROCESS_START_FAILED', 'Background process did not receive a PID.');
    }

    child.stdout?.pipe(stdout);
    child.stderr?.pipe(stderr);

    const record: ProcessRecord = {
      sessionId,
      pid: child.pid,
      command: input.command,
      cwd,
      startedAt: Date.now(),
      terminalAt: null,
      exitCode: null,
      signal: null,
      stdoutPath,
      stderrPath,
    };

    this.sessions.set(sessionId, { record, child });
    await this.persist(record);

    child.once('close', (exitCode, signal) => {
      record.terminalAt ??= Date.now();
      record.exitCode = exitCode;
      record.signal = signal as NodeJS.Signals | null;
      void this.persist(record);
    });

    return { ...record };
  }

  list(): ProcessRecord[] {
    return [...this.sessions.values()]
      .map(({ record }) => ({ ...record }))
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  async read(sessionId: string, maxBytes = MAX_COMMAND_OUTPUT_BYTES) {
    const owned = this.sessions.get(sessionId);
    if (!owned) {
      throw new CodespaceError('UNKNOWN_PROCESS_SESSION', 'Unknown background process session.');
    }
    const [stdout, stderr] = await Promise.all([
      readTail(owned.record.stdoutPath, maxBytes),
      readTail(owned.record.stderrPath, maxBytes),
    ]);
    return {
      ...owned.record,
      stdout: stdout.text,
      stderr: stderr.text,
      outputTruncated: stdout.truncated || stderr.truncated,
      running: owned.record.terminalAt === null && isAlive(owned.record.pid),
    };
  }

  async stop(sessionId: string): Promise<ProcessRecord> {
    const owned = this.sessions.get(sessionId);
    if (!owned) {
      throw new CodespaceError('UNKNOWN_PROCESS_SESSION', 'Unknown background process session.');
    }
    if (owned.record.terminalAt !== null || !isAlive(owned.record.pid)) {
      owned.record.terminalAt ??= Date.now();
      await this.persist(owned.record);
      return { ...owned.record };
    }

    const closed = owned.child
      ? new Promise<void>((resolve) => owned.child!.once('close', () => resolve()))
      : undefined;
    terminateOwned(owned.record, 'SIGTERM');

    if (closed) {
      await Promise.race([
        closed,
        new Promise<void>((resolve) => setTimeout(resolve, 500)),
      ]);
    }
    if (isAlive(owned.record.pid)) terminateOwned(owned.record, 'SIGKILL');
    owned.record.terminalAt ??= Date.now();
    await this.persist(owned.record);
    return { ...owned.record };
  }

  async reconcile(): Promise<ProcessRecord[]> {
    await fsp.mkdir(this.processesDir, { recursive: true });
    const entries = await fsp.readdir(this.processesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const record = JSON.parse(
          await fsp.readFile(path.join(this.processesDir, entry.name), 'utf8'),
        ) as ProcessRecord;
        if (!record.sessionId || typeof record.pid !== 'number') continue;
        if (record.terminalAt === null && !isAlive(record.pid)) {
          record.terminalAt = Date.now();
          await this.persist(record);
        }
        this.sessions.set(record.sessionId, { record });
      } catch {
        // Ignore malformed bridge-owned metadata; it is never adopted as a process.
      }
    }
    return this.list();
  }
}
