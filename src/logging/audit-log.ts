import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { RouteMode, RouteTier } from '../capabilities/route-types.js';
import type { CapabilityRisk } from '../capabilities/types.js';

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

export interface RoutingAuditEvent {
  event: 'route.created' | 'route.validated' | 'route.rejected' | 'route.skill_loaded';
  routeContextId: string;
  principalId: string;
  tier?: RouteTier;
  mode?: RouteMode;
  risk?: CapabilityRisk;
  capabilityIds?: string[];
  skillIds?: string[];
  toolName?: string;
  errorCode?: string;
  timestamp: string;
}
export interface AuditLogger {
  log(event: AuditEvent): Promise<void>;
}

export interface RoutingAuditLogger {
  logRouting(event: RoutingAuditEvent): void;
}

export const NOOP_ROUTING_AUDIT_LOGGER: RoutingAuditLogger = {
  logRouting: () => {},
};

export class FileAuditLogger implements AuditLogger, RoutingAuditLogger {
  readonly filePath: string;

  constructor(private readonly logDir: string) {
    this.filePath = path.join(logDir, 'audit.jsonl');
  }

  async log(event: AuditEvent): Promise<void> {
    this.append(event);
  }

  logRouting(event: RoutingAuditEvent): void {
    this.append(event);
  }

  private append(event: AuditEvent | RoutingAuditEvent): void {
    mkdirSync(this.logDir, { recursive: true });
    appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, 'utf8');
  }
}
