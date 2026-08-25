import { Worker } from 'node:worker_threads';
import {
  createDatabaseWorkerSource,
  type MemoryCheckpointResult,
  type MemoryWorkerOpenPayload,
  type MemoryWorkerRequest,
  type MemoryWorkerResponse,
  type MemoryWorkerSqlOperation,
  type SqlPrimitive,
} from './db-worker.js';

export class MemoryWorkerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'MemoryWorkerError';
    this.code = code;
  }
}

export interface MemoryWorkerClientOptions {
  maxResponseBytes?: number;
}

export interface MemoryWorkerOpenResult {
  dbPath: string;
  busyTimeoutMs: number;
  quickCheck: string;
  checkedAt: number;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export class MemoryWorkerClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private closed = false;
  private failed: Error | undefined;

  constructor(options: MemoryWorkerClientOptions = {}) {
    const maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 128) {
      throw new Error('maxResponseBytes must be an integer >= 128');
    }

    this.worker = new Worker(createDatabaseWorkerSource(), {
      eval: true,
      workerData: { maxResponseBytes },
    });

    this.worker.on('message', (response: MemoryWorkerResponse) => {
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.ok) {
        pending.resolve(response.result);
      } else {
        pending.reject(new MemoryWorkerError(
          response.error?.code ?? 'MEMORY_WORKER_ERROR',
          response.error?.message ?? 'Memory worker request failed',
        ));
      }
    });

    this.worker.on('error', (error) => {
      this.failed = error;
      this.rejectAll(error);
    });

    this.worker.on('exit', (code) => {
      if (!this.closed && code !== 0) {
        const error = this.failed ?? new MemoryWorkerError('MEMORY_WORKER_EXITED', `Memory worker exited with code ${code}`);
        this.failed = error;
        this.rejectAll(error);
      }
    });
  }

  async open(payload: MemoryWorkerOpenPayload): Promise<MemoryWorkerOpenResult> {
    return this.request('open', payload) as Promise<MemoryWorkerOpenResult>;
  }

  async exec(sql: string): Promise<void> {
    await this.request('exec', { sql });
  }

  async query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: SqlPrimitive[] = []): Promise<T[]> {
    return this.request('query', { sql, params }) as Promise<T[]>;
  }

  async transaction(operations: MemoryWorkerSqlOperation[]): Promise<unknown[]> {
    return this.request('transaction', { operations }) as Promise<unknown[]>;
  }

  async backup(backupPath: string): Promise<{ backupPath: string; createdAt: number }> {
    return this.request('backup', { backupPath }) as Promise<{ backupPath: string; createdAt: number }>;
  }

  async checkpoint(): Promise<MemoryCheckpointResult> {
    return this.request('checkpoint') as Promise<MemoryCheckpointResult>;
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
        if (!(error instanceof MemoryWorkerError && error.code === 'MEMORY_WORKER_EXITED')) throw error;
      }
    }
    this.closed = true;
    this.rejectAll(new MemoryWorkerError('MEMORY_WORKER_CLOSED', 'Memory worker client is closed'));
    await this.worker.terminate();
  }

  private request(command: MemoryWorkerRequest['command'], payload?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new MemoryWorkerError('MEMORY_WORKER_CLOSED', 'Memory worker client is closed'));
    if (this.failed) return Promise.reject(this.failed);

    const id = this.nextId++;
    const request: MemoryWorkerRequest = { id, command, payload };
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
