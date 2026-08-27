import { spawn } from 'node:child_process';

import { MAX_COMMAND_OUTPUT_BYTES, sanitizeEnvironment } from './constants.js';
import { resolveExistingPath } from './workspace.js';

export interface ExecuteCommandInput {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface ExecuteCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputTruncated: boolean;
}

function boundedCollector(limit: number) {
  const chunks: Buffer[] = [];
  let storedBytes = 0;
  let truncated = false;

  return {
    push(chunk: Buffer | string) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (storedBytes >= limit) {
        truncated = true;
        return;
      }
      const remaining = limit - storedBytes;
      if (buffer.length > remaining) {
        chunks.push(buffer.subarray(0, remaining));
        storedBytes += remaining;
        truncated = true;
        return;
      }
      chunks.push(buffer);
      storedBytes += buffer.length;
    },
    text() {
      return Buffer.concat(chunks).toString('utf8');
    },
    get truncated() {
      return truncated;
    },
  };
}

function terminateProcess(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    if (process.platform !== 'win32') {
      process.kill(-pid, signal);
    } else {
      process.kill(pid, signal);
    }
  } catch {
    // The process may already have exited.
  }
}

export async function executeCommand(
  root: string,
  input: ExecuteCommandInput,
  allowedBase?: string,
): Promise<ExecuteCommandResult> {
  const cwd = await resolveExistingPath(root, input.cwd ?? '.', allowedBase);
  const timeoutMs = input.timeoutMs ?? 120_000;
  const stdout = boundedCollector(MAX_COMMAND_OUTPUT_BYTES);
  const stderr = boundedCollector(MAX_COMMAND_OUTPUT_BYTES);

  return await new Promise<ExecuteCommandResult>((resolve, reject) => {
    const child = spawn('/bin/bash', ['-lc', input.command], {
      cwd,
      env: sanitizeEnvironment(),
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let timedOut = false;
    let settled = false;
    let forceTimer: NodeJS.Timeout | undefined;

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceTimer) clearTimeout(forceTimer);
      reject(error);
    });

    child.once('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceTimer) clearTimeout(forceTimer);
      resolve({
        exitCode,
        stdout: stdout.text(),
        stderr: stderr.text(),
        timedOut,
        outputTruncated: stdout.truncated || stderr.truncated,
      });
    });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminateProcess(child.pid, 'SIGTERM');
      forceTimer = setTimeout(() => terminateProcess(child.pid, 'SIGKILL'), 250);
      forceTimer.unref();
    }, Math.max(1, timeoutMs));
    timeoutTimer.unref();
  });
}
