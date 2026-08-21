import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export interface AuditEvent {
  timestamp: string;
  requestId: string;
  method: string;
  route: string;
  status: number;
  durationMs: number;
  keyId: string | null;
  keyName: string | null;
}

export interface AuditLogger {
  log(event: AuditEvent): Promise<void>;
}

export class FileAuditLogger implements AuditLogger {
  readonly filePath: string;

  constructor(private readonly logDir: string) {
    this.filePath = path.join(logDir, 'audit.jsonl');
  }

  async log(event: AuditEvent): Promise<void> {
    mkdirSync(this.logDir, { recursive: true });
    appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, 'utf8');
  }
}
