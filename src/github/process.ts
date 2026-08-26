import { spawn } from 'node:child_process';

const MAX_OUTPUT_BYTES = 256 * 1024;

export interface SpawnRequest {
  executable: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  stdin?: string;
  redact?: string[];
}

export interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputTruncated: boolean;
}

export type ProcessRunner = (request: SpawnRequest) => Promise<SpawnResult>;

function appendBounded(current: string, chunk: Buffer, state: { truncated: boolean }): string {
  const combined = Buffer.concat([Buffer.from(current, 'utf8'), chunk]);
  if (combined.length <= MAX_OUTPUT_BYTES) return combined.toString('utf8');
  state.truncated = true;
  return combined.subarray(combined.length - MAX_OUTPUT_BYTES).toString('utf8');
}

function redactText(value: string, secrets: string[] | undefined): string {
  let output = value;
  const unique = [...new Set((secrets ?? []).filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const secret of unique) output = output.split(secret).join('[REDACTED_GITHUB_CREDENTIAL]');
  return output;
}

export async function runBoundedProcess(request: SpawnRequest): Promise<SpawnResult> {
  const child = spawn(request.executable, [...request.args], {
    cwd: request.cwd,
    env: request.env ?? process.env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });
  let stdout = '';
  let stderr = '';
  const state = { truncated: false };
  let timedOut = false;

  child.stdout.on('data', (chunk: Buffer) => { stdout = appendBounded(stdout, chunk, state); });
  child.stderr.on('data', (chunk: Buffer) => { stderr = appendBounded(stderr, chunk, state); });
  if (request.stdin !== undefined) child.stdin.end(request.stdin);
  else child.stdin.end();

  const timeoutMs = Math.max(1, request.timeoutMs);
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);

  return await new Promise<SpawnResult>((resolve, reject) => {
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: redactText(stdout, request.redact),
        stderr: redactText(stderr, request.redact),
        timedOut,
        outputTruncated: state.truncated,
      });
    });
  });
}
