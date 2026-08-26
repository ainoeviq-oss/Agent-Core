import { describe, expect, it } from 'vitest';
import {
  AgentCoreRouteError,
  RouteContextStore,
} from '../src/runtime/route-context-store.js';
import type { RoutePlan } from '../src/capabilities/route-types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function routePlan(overrides: Partial<RoutePlan> = {}): RoutePlan {
  return {
    tier: 'atomic',
    mode: 'atomic_direct',
    domain: 'general',
    confidence: 0.5,
    risk: 'low',
    recommendedCapabilities: [],
    requiredSkillLoads: [],
    allowedTools: ['read_file', 'write_file'],
    verification: { required: true, suggestedTools: ['read_file'] },
    reasonCodes: ['atomic_direct'],
    ...overrides,
  };
}

function expectCode(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(AgentCoreRouteError);
    expect((error as AgentCoreRouteError).code).toBe(code);
  }
}

describe('RouteContextStore', () => {
  it('creates a principal-bound UUID route with a 30-minute lifetime', () => {
    const now = Date.parse('2026-08-23T15:00:00.000Z');
    const store = new RouteContextStore({ now: () => now });
    const context = store.create('key-a', routePlan());

    expect(context.routeContextId).toMatch(UUID_RE);
    expect(context.principalId).toBe('key-a');
    expect(context.loadedSkillIds).toEqual([]);
    expect(context.createdAt).toBe('2026-08-23T15:00:00.000Z');
    expect(context.expiresAt).toBe('2026-08-23T15:30:00.000Z');
  });

  it('persists the resolved project identity on the route context', () => {
    const store = new RouteContextStore();
    const context = store.create('key-a', routePlan(), { projectId: '/workspace/project-b' });
    expect(context.projectId).toBe('/workspace/project-b');
    expect(store.get(context.routeContextId)?.projectId).toBe('/workspace/project-b');
  });

  it('lists active route IDs only for the requested principal/project scope', () => {
    const store = new RouteContextStore();
    const a = store.create('key-a', routePlan(), { projectId: '/workspace/a' });
    store.create('key-a', routePlan(), { projectId: '/workspace/b' });
    store.create('key-b', routePlan(), { projectId: '/workspace/a' });
    expect(store.activeRouteContextIds('key-a', '/workspace/a')).toEqual([a.routeContextId]);
  });

  it('rejects route use by another authenticated principal', () => {
    const store = new RouteContextStore();
    const context = store.create('key-a', routePlan());
    expectCode(
      () => store.validate(context.routeContextId, 'key-b', 'write_file'),
      'ROUTE_PRINCIPAL_MISMATCH',
    );
  });

  it('rejects tools that the route did not allow', () => {
    const store = new RouteContextStore();
    const context = store.create('key-a', routePlan({ allowedTools: ['read_file'] }));

    expectCode(
      () => store.validate(context.routeContextId, 'key-a', 'write_file'),
      'ROUTE_TOOL_NOT_ALLOWED',
    );
  });

  it('expires routes after 30 minutes and removes them from lookup', () => {
    let now = Date.parse('2026-08-23T15:00:00.000Z');
    const store = new RouteContextStore({ now: () => now });
    const context = store.create('key-a', routePlan());
    now += 30 * 60_000 + 1;

    expectCode(
      () => store.validate(context.routeContextId, 'key-a', 'read_file'),
      'ROUTE_EXPIRED',
    );
    expect(store.get(context.routeContextId)).toBeNull();
  });

  it('blocks execution until every required native skill is marked loaded', () => {
    const store = new RouteContextStore();
    const context = store.create('key-a', routePlan({
      requiredSkillLoads: [{ id: 'frontend-quality', name: 'frontend-quality' }],
    }));

    expectCode(
      () => store.validate(context.routeContextId, 'key-a', 'write_file'),
      'ROUTE_SKILL_REQUIRED',
    );

    const loaded = store.markSkillLoaded(
      context.routeContextId,
      'key-a',
      'frontend-quality',
    );
    expect(loaded.loadedSkillIds).toEqual(['frontend-quality']);
    expect(store.validate(context.routeContextId, 'key-a', 'write_file'))
      .toMatchObject({ routeContextId: context.routeContextId });
  });

  it('reports unknown route IDs with a stable error code', () => {
    const store = new RouteContextStore();
    expectCode(
      () => store.validate('11111111-1111-4111-8111-111111111111', 'key-a', 'read_file'),
      'ROUTE_NOT_FOUND',
    );
  });

  it('caps active contexts at 256 by pruning the oldest route', () => {
    let now = Date.parse('2026-08-23T15:00:00.000Z');
    const store = new RouteContextStore({ now: () => now });
    const oldest = store.create('key-a', routePlan());

    for (let index = 0; index < 256; index += 1) {
      now += 1;
      store.create('key-a', routePlan());
    }

    expect(store.get(oldest.routeContextId)).toBeNull();
  });
});
