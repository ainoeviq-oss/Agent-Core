export type ExecutionWorkerCommand = 'open' | 'exec' | 'query' | 'transaction' | 'checkpoint' | 'integrity' | 'close';

export type ExecutionSqlPrimitive = string | number | bigint | null | Uint8Array;

export interface ExecutionWorkerOpenPayload {
  dbPath: string;
  busyTimeoutMs?: number;
}

export interface ExecutionWorkerSqlOperation {
  kind: 'exec' | 'run' | 'query';
  sql: string;
  params?: ExecutionSqlPrimitive[];
  mode?: 'all' | 'get';
}

export interface ExecutionWorkerRequest {
  id: number;
  command: ExecutionWorkerCommand;
  payload?: unknown;
}

export interface SerializedExecutionWorkerError {
  code: string;
  message: string;
}

export interface ExecutionWorkerResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: SerializedExecutionWorkerError;
}

export interface ExecutionCheckpointResult {
  busy: number;
  logFrames: number;
  checkpointedFrames: number;
  mode: 'TRUNCATE';
}

/**
 * The execution database is owned exclusively by this worker. The parent
 * process communicates through a bounded message protocol and never receives
 * a DatabaseSync reference.
 */
export function createExecutionDatabaseWorkerSource(): string {
  return String.raw`
    const { parentPort, workerData } = require('node:worker_threads');
    const { mkdirSync } = require('node:fs');
    const path = require('node:path');
    const { DatabaseSync } = require('node:sqlite');

    let db = null;
    const maxResponseBytes = Number(workerData?.maxResponseBytes || 1048576);

    function errorCode(error, fallback) {
      if (error && typeof error === 'object' && typeof error.code === 'string' && error.code.trim()) {
        return String(error.code);
      }
      return fallback;
    }

    function serializeError(error, fallback) {
      return {
        code: errorCode(error, fallback),
        message: error instanceof Error ? error.message : String(error),
      };
    }

    function resultBytes(value) {
      try {
        return Buffer.byteLength(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item), 'utf8');
      } catch {
        return maxResponseBytes + 1;
      }
    }

    function sendResult(id, result) {
      if (resultBytes(result) > maxResponseBytes) {
        parentPort.postMessage({
          id,
          ok: false,
          error: {
            code: 'EXECUTION_RESULT_TOO_LARGE',
            message: 'Execution worker result exceeded the configured response bound',
          },
        });
        return;
      }
      parentPort.postMessage({ id, ok: true, result });
    }

    function sendError(id, error, fallback) {
      parentPort.postMessage({ id, ok: false, error: serializeError(error, fallback) });
    }

    function requireDb() {
      if (!db) {
        const error = new Error('Execution database is not open');
        error.code = 'EXECUTION_DB_NOT_OPEN';
        throw error;
      }
      return db;
    }

    function executeOperation(database, operation) {
      if (!operation || typeof operation !== 'object' || typeof operation.kind !== 'string' || typeof operation.sql !== 'string') {
        const error = new Error('Invalid execution transaction operation');
        error.code = 'EXECUTION_INVALID_OPERATION';
        throw error;
      }
      if (operation.kind === 'exec') {
        database.exec(operation.sql);
        return null;
      }
      const statement = database.prepare(operation.sql);
      const params = Array.isArray(operation.params) ? operation.params : [];
      if (operation.kind === 'run') {
        const result = statement.run(...params);
        return { changes: Number(result.changes), lastInsertRowid: String(result.lastInsertRowid) };
      }
      if (operation.kind === 'query') {
        return operation.mode === 'get' ? statement.get(...params) : statement.all(...params);
      }
      const error = new Error('Unsupported execution transaction operation kind');
      error.code = 'EXECUTION_INVALID_OPERATION';
      throw error;
    }

    function checkpoint(database) {
      const row = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() || {};
      return {
        busy: Number(row.busy || 0),
        logFrames: Number(row.log || 0),
        checkpointedFrames: Number(row.checkpointed || 0),
        mode: 'TRUNCATE',
      };
    }

    parentPort.on('message', (request) => {
      const id = Number(request?.id);
      const command = request?.command;
      try {
        if (command === 'open') {
          if (db) {
            const error = new Error('Execution database is already open');
            error.code = 'EXECUTION_DB_ALREADY_OPEN';
            throw error;
          }
          const payload = request.payload || {};
          if (typeof payload.dbPath !== 'string' || payload.dbPath.trim() === '') {
            const error = new Error('dbPath is required');
            error.code = 'EXECUTION_DB_OPEN_FAILED';
            throw error;
          }
          try {
            if (payload.dbPath !== ':memory:') {
              mkdirSync(path.dirname(path.resolve(payload.dbPath)), { recursive: true });
            }
            db = new DatabaseSync(payload.dbPath);
            db.exec('PRAGMA foreign_keys = ON');
            db.exec('PRAGMA journal_mode = WAL');
            db.exec('PRAGMA wal_autocheckpoint = 4096');
            db.exec('PRAGMA synchronous = NORMAL');
            const timeout = Number.isSafeInteger(payload.busyTimeoutMs) && payload.busyTimeoutMs > 0
              ? payload.busyTimeoutMs
              : 5000;
            db.exec('PRAGMA busy_timeout = ' + timeout);
            if (typeof db.enableDefensive === 'function') db.enableDefensive(true);
            const check = db.prepare('PRAGMA quick_check').get();
            const quickCheck = String(check?.quick_check || 'unknown');
            if (quickCheck !== 'ok') throw new Error('SQLite quick_check failed during execution DB open');
            sendResult(id, { dbPath: payload.dbPath, busyTimeoutMs: timeout, quickCheck, checkedAt: Date.now() });
          } catch (error) {
            if (db) {
              try { db.close(); } catch {}
              db = null;
            }
            parentPort.postMessage({
              id,
              ok: false,
              error: {
                code: 'EXECUTION_DB_OPEN_FAILED',
                message: error instanceof Error ? error.message : String(error),
              },
            });
          }
          return;
        }

        if (command === 'exec') {
          const database = requireDb();
          const sql = request.payload?.sql;
          if (typeof sql !== 'string') {
            const error = new Error('sql is required');
            error.code = 'EXECUTION_INVALID_SQL';
            throw error;
          }
          database.exec(sql);
          sendResult(id, null);
          return;
        }

        if (command === 'query') {
          const database = requireDb();
          const sql = request.payload?.sql;
          const params = Array.isArray(request.payload?.params) ? request.payload.params : [];
          if (typeof sql !== 'string') {
            const error = new Error('sql is required');
            error.code = 'EXECUTION_INVALID_SQL';
            throw error;
          }
          sendResult(id, database.prepare(sql).all(...params));
          return;
        }

        if (command === 'transaction') {
          const database = requireDb();
          const operations = request.payload?.operations;
          if (!Array.isArray(operations) || operations.length === 0 || operations.length > 1000) {
            const error = new Error('transaction requires 1..1000 ordered operations');
            error.code = 'EXECUTION_INVALID_TRANSACTION';
            throw error;
          }
          database.exec('BEGIN IMMEDIATE');
          try {
            const results = operations.map((operation) => executeOperation(database, operation));
            database.exec('COMMIT');
            sendResult(id, results);
          } catch (error) {
            try { database.exec('ROLLBACK'); } catch {}
            throw error;
          }
          return;
        }

        if (command === 'checkpoint') {
          sendResult(id, checkpoint(requireDb()));
          return;
        }

        if (command === 'integrity') {
          const database = requireDb();
          const row = database.prepare('PRAGMA integrity_check').get();
          const result = String(row?.integrity_check || 'unknown');
          sendResult(id, { ok: result === 'ok', result });
          return;
        }

        if (command === 'close') {
          let checkpointResult = null;
          if (db) {
            checkpointResult = checkpoint(db);
            db.close();
            db = null;
          }
          sendResult(id, { closed: true, checkpoint: checkpointResult });
          return;
        }

        const error = new Error('Unsupported execution worker command');
        error.code = 'EXECUTION_UNKNOWN_COMMAND';
        throw error;
      } catch (error) {
        sendError(id, error, errorCode(error, 'EXECUTION_WORKER_ERROR'));
      }
    });
  `;
}
