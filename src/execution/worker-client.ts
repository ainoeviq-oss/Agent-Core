import { Worker } from 'node:worker_threads';
import {
  createExecutionDatabaseWorkerSource,
  type ExecutionCheckpointResult,
  type ExecutionSqlPrimitive,
  type ExecutionWorkerOpenPayload,
  type ExecutionWorkerRequest,
  type ExecutionWorkerResponse,
  type ExecutionWorkerSqlOperation,
} from './db-worker.js';

export class ExecutionWorkerError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ExecutionWorkerError';
  }
}

export interface ExecutionWorkerClientOptions {
  maxResponseBytes?: number;
}

export interface ExecutionWorkerOpenResult {
  dbPath: string;
  busyTimeoutMs: number;
  quickCheck: string;
  checkedAt: number;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export class ExecutionWorkerClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private closed = false;
  private failed: Error | undefined;

  constructor(options: ExecutionWorkerClientOptions = {}) {
    const maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 128) {
      throw new Error('maxResponseBytes must be an integer >= 128');
    }
    this.worker = new Worker(createExecutionDatabaseWorkerSource(), {
      eval: true,
      workerData: { maxResponseBytes },
    });
    this.worker.on('message', (response: ExecutionWorkerResponse) => {
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new ExecutionWorkerError(
        response.error?.code ?? 'EXECUTION_WORKER_ERROR',
        response.error?.message ?? 'Execution worker request failed',
      ));
    });
    this.worker.on('error', (error) => {
      this.failed = error;
      this.rejectAll(error);
    });
    this.worker.on('exit', (code) => {
      if (!this.closed && code !== 0) {
        const error = this.failed ?? new ExecutionWorkerError('EXECUTION_WORKER_EXITED', `Execution worker exited with code ${code}`);
        this.failed = error;
        this.rejectAll(error);
      }
    });
  }

  async open(payload: ExecutionWorkerOpenPayload): Promise<ExecutionWorkerOpenResult> {
    return this.request('open', payload) as Promise<ExecutionWorkerOpenResult>;
  }

  async exec(sql: string): Promise<void> {
    await this.request('exec', { sql });
  }

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: ExecutionSqlPrimitive[] = [],
  ): Promise<T[]> {
    return this.request('query', { sql, params }) as Promise<T[]>;
  }

  async transaction(operations: ExecutionWorkerSqlOperation[]): Promise<unknown[]> {
    return this.request('transaction', { operations }) as Promise<unknown[]>;
  }

  async checkpoint(): Promise<ExecutionCheckpointResult> {
    return this.request('checkpoint') as Promise<ExecutionCheckpointResult>;
  }

  async integrity(): Promise<{ ok: boolean; result: string }> {
    return this.request('integrity') as Promise<{ ok: boolean; result: string }>;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (!this.failed) {
      try {
        await this.request('close');
      } catch (error) {
        if (!(error instanceof ExecutionWorkerError && error.code === 'EXECUTION_WORKER_EXITED')) throw error;
      }
    }
    this.closed = true;
    this.rejectAll(new ExecutionWorkerError('EXECUTION_WORKER_CLOSED', 'Execution worker client is closed'));
    await this.worker.terminate();
  }

  private request(command: ExecutionWorkerRequest['command'], payload?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new ExecutionWorkerError('EXECUTION_WORKER_CLOSED', 'Execution worker client is closed'));
    if (this.failed) return Promise.reject(this.failed);
    const id = this.nextId++;
    const request: ExecutionWorkerRequest = { id, command, payload };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage(request);
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
