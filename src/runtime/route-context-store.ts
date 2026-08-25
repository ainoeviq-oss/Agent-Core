import { randomUUID } from 'node:crypto';
import type { RoutePlan } from '../capabilities/route-types.js';
import {
  NOOP_ROUTING_AUDIT_LOGGER,
  type RoutingAuditLogger,
} from '../logging/audit-log.js';

export type AgentCoreRouteErrorCode =
  | 'ROUTE_NOT_FOUND'
  | 'ROUTE_EXPIRED'
  | 'ROUTE_PRINCIPAL_MISMATCH'
  | 'ROUTE_TOOL_NOT_ALLOWED'
  | 'ROUTE_SKILL_REQUIRED'
  | 'ROUTE_MEMORY_GUARDRAIL_BLOCKED';

export class AgentCoreRouteError extends Error {
  constructor(
    public readonly code: AgentCoreRouteErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AgentCoreRouteError';
  }
}

export interface RouteReservation {
  routeContextId: string;
  createdAt: string;
  expiresAt: string;
}

export interface RouteMemoryGuardrailRef {
  memoryId: string;
  revisionId?: string;
  canonicalKey?: string;
  sourceEventId?: string;
}

export interface RouteMemorySnapshot {
  memoryContextId: string;
  memorySnapshotHash: string;
  blockingGuardrailMemoryIds: string[];
  blockingGuardrails?: RouteMemoryGuardrailRef[];
  enforceHardGuardrails: boolean;
}

export interface RouteCreateOptions {
  reservation?: RouteReservation;
  memorySnapshot?: RouteMemorySnapshot;
  continuityTurnId?: string;
  continuityTaskId?: string;
  continuitySnapshotHash?: string;
}

export interface RouteContext extends RoutePlan {
  routeContextId: string;
  principalId: string;
  loadedSkillIds: string[];
  createdAt: string;
  expiresAt: string;
  memorySnapshot?: RouteMemorySnapshot;
  continuityTurnId?: string;
  continuityTaskId?: string;
  continuitySnapshotHash?: string;
}
export interface RouteContextStoreOptions {
  now?: () => number;
  ttlMs?: number;
  maxContexts?: number;
  auditLogger?: RoutingAuditLogger;
}

const DEFAULT_TTL_MS = 30 * 60_000;
const DEFAULT_MAX_CONTEXTS = 256;

export class RouteContextStore {
  private readonly contexts = new Map<string, RouteContext>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxContexts: number;
  private readonly auditLogger: RoutingAuditLogger;

  constructor(options: RouteContextStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxContexts = options.maxContexts ?? DEFAULT_MAX_CONTEXTS;
    this.auditLogger = options.auditLogger ?? NOOP_ROUTING_AUDIT_LOGGER;
  }

  reserve(): RouteReservation {
    const now = this.now();
    return {
      routeContextId: randomUUID(),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
    };
  }

  create(principalId: string, plan: RoutePlan, options: RouteCreateOptions = {}): RouteContext {
    this.pruneExpired();
    this.pruneOldestForCapacity();
    const reservation = options.reservation ?? this.reserve();
    if (Date.parse(reservation.expiresAt) <= this.now()) {
      throw new AgentCoreRouteError('ROUTE_EXPIRED', 'Reserved route context has already expired');
    }
    if (this.contexts.has(reservation.routeContextId)) {
      throw new Error(`Route context already exists: ${reservation.routeContextId}`);
    }
    const context: RouteContext = {
      ...structuredClone(plan),
      routeContextId: reservation.routeContextId,
      principalId,
      loadedSkillIds: [],
      createdAt: reservation.createdAt,
      expiresAt: reservation.expiresAt,
      ...(options.memorySnapshot ? { memorySnapshot: structuredClone(options.memorySnapshot) } : {}),
      ...(options.continuityTurnId ? { continuityTurnId: options.continuityTurnId } : {}),
      ...(options.continuityTaskId ? { continuityTaskId: options.continuityTaskId } : {}),
      ...(options.continuitySnapshotHash ? { continuitySnapshotHash: options.continuitySnapshotHash } : {}),
    };
    this.contexts.set(context.routeContextId, context);
    this.auditLogger.logRouting({
      event: 'route.created',
      routeContextId: context.routeContextId,
      principalId,
      tier: context.tier,
      mode: context.mode,
      risk: context.risk,
      capabilityIds: context.recommendedCapabilities.map((item) => item.id),
      skillIds: context.requiredSkillLoads.map((item) => item.id),
      timestamp: context.createdAt,
    });
    return structuredClone(context);
  }

  get(routeContextId: string): RouteContext | null {
    const context = this.contexts.get(routeContextId);
    if (!context) return null;
    if (this.isExpired(context)) {
      this.contexts.delete(routeContextId);
      return null;
    }
    this.pruneExpired(routeContextId);
    return structuredClone(context);
  }

  markSkillLoaded(
    routeContextId: string,
    principalId: string,
    skillId: string,
  ): RouteContext {
    try {
      const context = this.requireOwned(routeContextId, principalId);
      if (!context.loadedSkillIds.includes(skillId)) {
        context.loadedSkillIds.push(skillId);
      }
      this.auditLogger.logRouting({
        event: 'route.skill_loaded',
        routeContextId,
        principalId,
        skillIds: [...context.loadedSkillIds],
        timestamp: this.timestamp(),
      });
      return structuredClone(context);
    } catch (error) {
      this.auditRejected(routeContextId, principalId, 'skill_load', error, [skillId]);
      throw error;
    }
  }

  validate(
    routeContextId: string,
    principalId: string,
    toolName: string,
  ): RouteContext {
    try {
      const context = this.requireOwned(routeContextId, principalId);
      const memory = context.memorySnapshot;
      if (memory?.enforceHardGuardrails && memory.blockingGuardrailMemoryIds.length > 0) {
        const guardrails = memory.blockingGuardrails ?? memory.blockingGuardrailMemoryIds.map((memoryId) => ({ memoryId }));
        throw new AgentCoreRouteError(
          'ROUTE_MEMORY_GUARDRAIL_BLOCKED',
          `Route is blocked by ${guardrails.length} active hard memory guardrail(s)`,
          { memoryContextId: memory.memoryContextId, memorySnapshotHash: memory.memorySnapshotHash, guardrails },
        );
      }
      if (!context.allowedTools.includes(toolName)) {
        throw new AgentCoreRouteError(
          'ROUTE_TOOL_NOT_ALLOWED',
          `Route context does not allow tool: ${toolName}`,
        );
      }
      const loaded = new Set(context.loadedSkillIds);
      const missing = context.requiredSkillLoads.find((skill) => !loaded.has(skill.id));
      if (missing) {
        throw new AgentCoreRouteError(
          'ROUTE_SKILL_REQUIRED',
          `Required skill has not been loaded for this route: ${missing.id}`,
        );
      }
      this.auditLogger.logRouting({
        event: 'route.validated',
        routeContextId,
        principalId,
        tier: context.tier,
        mode: context.mode,
        risk: context.risk,
        toolName,
        timestamp: this.timestamp(),
      });
      return structuredClone(context);
    } catch (error) {
      this.auditRejected(routeContextId, principalId, toolName, error);
      throw error;
    }
  }

  private requireOwned(routeContextId: string, principalId: string): RouteContext {
    const context = this.contexts.get(routeContextId);
    if (!context) {
      throw new AgentCoreRouteError('ROUTE_NOT_FOUND', 'Route context was not found');
    }
    if (this.isExpired(context)) {
      this.contexts.delete(routeContextId);
      throw new AgentCoreRouteError('ROUTE_EXPIRED', 'Route context has expired');
    }
    this.pruneExpired(routeContextId);
    if (context.principalId !== principalId) {
      throw new AgentCoreRouteError(
        'ROUTE_PRINCIPAL_MISMATCH',
        'Route context belongs to another authenticated principal',
      );
    }
    return context;
  }

  private auditRejected(
    routeContextId: string,
    principalId: string,
    toolName: string,
    error: unknown,
    skillIds?: string[],
  ): void {
    if (!(error instanceof AgentCoreRouteError)) return;
    this.auditLogger.logRouting({
      event: 'route.rejected',
      routeContextId,
      principalId,
      toolName,
      errorCode: error.code,
      ...(skillIds ? { skillIds } : {}),
      timestamp: this.timestamp(),
    });
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }

  private isExpired(context: RouteContext): boolean {
    return Date.parse(context.expiresAt) <= this.now();
  }

  private pruneExpired(exceptId?: string): void {
    for (const [id, context] of this.contexts) {
      if (id !== exceptId && this.isExpired(context)) this.contexts.delete(id);
    }
  }

  private pruneOldestForCapacity(): void {
    while (this.contexts.size >= this.maxContexts) {
      const oldestId = this.contexts.keys().next().value as string | undefined;
      if (!oldestId) return;
      this.contexts.delete(oldestId);
    }
  }
}
