import { randomUUID } from 'node:crypto';
import { access, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface ExecutionAttemptPaths {
  directory: string;
  stdoutPath: string;
  stderrPath: string;
  resultPath: string;
}

export interface ExecutionLogReadResult {
  data: string;
  offset: number;
  nextOffset: number;
  totalBytes: number;
  eof: boolean;
}

export interface ExecutionResultMarker {
  version: 1;
  runId: string;
  nodeId: string;
  attemptId: string;
  attemptNo: number;
  state: 'succeeded' | 'failed' | 'interrupted' | 'cancelled';
  startedAt: number;
  finishedAt: number;
  exitCode: number | null;
  signal: string | null;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutSha256: string;
  stderrSha256: string;
  error?: string;
}

export class ExecutionLogStoreError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ExecutionLogStoreError';
  }
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const MAX_LOG_READ_BYTES = 1024 * 1024;

function fail(code: string, message: string): never {
  throw new ExecutionLogStoreError(code, message);
}

function segment(value: string, field: string): string {
  if (typeof value !== 'string' || !SAFE_SEGMENT.test(value)) {
    fail('EXECUTION_LOG_ID_INVALID', `${field} is not a safe path segment`);
  }
  return value;
}

function attemptNumber(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 999_999) {
    fail('EXECUTION_ATTEMPT_NUMBER_INVALID', 'attemptNo must be an integer between 1 and 999999');
  }
  return value;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export class ExecutionLogStore {
  readonly root: string;

  constructor(root: string) {
    if (typeof root !== 'string' || !root.trim()) fail('EXECUTION_LOG_ROOT_REQUIRED', 'Execution log root is required');
    this.root = path.resolve(root);
  }

  paths(runId: string, nodeId: string, attemptNo: number): ExecutionAttemptPaths {
    const safeRunId = segment(runId, 'runId');
    const safeNodeId = segment(nodeId, 'nodeId');
    const safeAttemptNo = attemptNumber(attemptNo);
    const directory = path.join(this.root, safeRunId, safeNodeId);
    const stem = `attempt-${String(safeAttemptNo).padStart(3, '0')}`;
    return {
      directory,
      stdoutPath: path.join(directory, `${stem}.stdout.log`),
      stderrPath: path.join(directory, `${stem}.stderr.log`),
      resultPath: path.join(directory, `${stem}.result.json`),
    };
  }

  async prepareAttempt(runId: string, nodeId: string, attemptNo: number): Promise<ExecutionAttemptPaths> {
    const paths = this.paths(runId, nodeId, attemptNo);
    await mkdir(paths.directory, { recursive: true });
    if (await exists(paths.stdoutPath) || await exists(paths.stderrPath) || await exists(paths.resultPath)) {
      fail('EXECUTION_ATTEMPT_EXISTS', `Attempt evidence already exists for ${runId}/${nodeId}/${attemptNo}`);
    }
    try {
      await writeFile(paths.stdoutPath, '', { encoding: 'utf8', flag: 'wx' });
      await writeFile(paths.stderrPath, '', { encoding: 'utf8', flag: 'wx' });
      return paths;
    } catch (error) {
      await rm(paths.stdoutPath, { force: true }).catch(() => undefined);
      await rm(paths.stderrPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async readLog(
    runId: string,
    nodeId: string,
    attemptNo: number,
    stream: 'stdout' | 'stderr',
    offset = 0,
    maxBytes = 64 * 1024,
  ): Promise<ExecutionLogReadResult> {
    if (stream !== 'stdout' && stream !== 'stderr') fail('EXECUTION_LOG_STREAM_INVALID', 'stream must be stdout or stderr');
    if (!Number.isInteger(offset) || offset < 0) fail('EXECUTION_LOG_OFFSET_INVALID', 'offset must be a non-negative integer');
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_LOG_READ_BYTES) {
      fail('EXECUTION_LOG_READ_LIMIT_INVALID', `maxBytes must be between 1 and ${MAX_LOG_READ_BYTES}`);
    }
    const paths = this.paths(runId, nodeId, attemptNo);
    const target = stream === 'stdout' ? paths.stdoutPath : paths.stderrPath;
    const info = await stat(target);
    const totalBytes = info.size;
    if (offset > totalBytes) fail('EXECUTION_LOG_OFFSET_INVALID', 'offset is beyond the end of the log');
    if (offset === totalBytes) return { data: '', offset, nextOffset: offset, totalBytes, eof: true };

    const length = Math.min(maxBytes, totalBytes - offset);
    const buffer = Buffer.alloc(length);
    const handle = await open(target, 'r');
    try {
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      const nextOffset = offset + bytesRead;
      return {
        data: buffer.subarray(0, bytesRead).toString('utf8'),
        offset,
        nextOffset,
        totalBytes,
        eof: nextOffset >= totalBytes,
      };
    } finally {
      await handle.close();
    }
  }

  async readResult(runId: string, nodeId: string, attemptNo: number): Promise<ExecutionResultMarker | null> {
    const paths = this.paths(runId, nodeId, attemptNo);
    let body: string;
    try {
      body = await readFile(paths.resultPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const parsed = JSON.parse(body) as ExecutionResultMarker;
    if (
      parsed?.version !== 1
      || parsed.runId !== runId
      || parsed.nodeId !== nodeId
      || parsed.attemptNo !== attemptNo
      || typeof parsed.attemptId !== 'string'
      || !['succeeded', 'failed', 'interrupted', 'cancelled'].includes(parsed.state)
    ) {
      fail('EXECUTION_RESULT_INVALID', 'Execution result marker does not match the requested attempt');
    }
    return parsed;
  }

  async writeResultAtomic(marker: ExecutionResultMarker): Promise<string> {
    const paths = this.paths(marker.runId, marker.nodeId, marker.attemptNo);
    segment(marker.attemptId, 'attemptId');
    if (marker.version !== 1) fail('EXECUTION_RESULT_INVALID', 'Unsupported execution result version');
    if (await exists(paths.resultPath)) fail('EXECUTION_RESULT_EXISTS', 'Terminal execution result already exists');
    await mkdir(paths.directory, { recursive: true });
    const tempPath = `${paths.resultPath}.tmp-${process.pid}-${randomUUID()}`;
    const payload = `${JSON.stringify(marker, null, 2)}\n`;
    const handle = await open(tempPath, 'wx');
    try {
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      if (await exists(paths.resultPath)) fail('EXECUTION_RESULT_EXISTS', 'Terminal execution result already exists');
      await rename(tempPath, paths.resultPath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
    return paths.resultPath;
  }
}
