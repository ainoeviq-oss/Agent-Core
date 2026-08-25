import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createRuntimeServices } from '../src/runtime/services.js';

function tempDb(): string {
  const base = process.env.TEMP || process.env.TMP || os.tmpdir();
  return path.join(mkdtempSync(path.join(base, 'agent-core-preflight-')), 'memory.sqlite');
}

describe('route-time deterministic memory preflight service', () => {
  it('constructs one runtime memory facade and persists evidence, hard guardrails, conflicts, failures, decisions, and snapshot identity', async () => {
    const root = path.resolve(process.env.TEMP || process.env.TMP || os.tmpdir(), 'agent-core-preflight-root');
    const config = loadConfig({}, root).memory;
    const runtime = createRuntimeServices([root], path.join(root, 'capabilities'), undefined, {
      ...config,
      enabled: true,
      dbPath: tempDb(),
    });

    expect(runtime.memory).toBe(runtime.memory);

    const scope = { principalId: 'principal-a', projectId: 'project-a', threadId: 'thread-a' };
    const guardrail = await runtime.memory.commit({
      scope,
      canonicalKey: 'guardrail.storage.drive',
      kind: 'guardrail',
      value: 'Build artifacts must stay on drive F.',
      enforcement: 'hard',
      importance: 1,
      pinned: true,
      sourceType: 'test',
    });
    const failure = await runtime.memory.commit({
      scope,
      canonicalKey: 'failure.build.cache',
      kind: 'failure',
      value: 'Build cache failed previously when output moved away from drive F.',
      importance: 0.9,
      sourceType: 'test',
    });
    const decision = await runtime.memory.commit({
      scope,
      canonicalKey: 'decision.build.layout',
      kind: 'decision',
      value: 'Build output uses the project runtime directory on drive F.',
      importance: 0.9,
      sourceType: 'test',
    });
    const observationA = await runtime.memory.commit({
      scope,
      canonicalKey: 'observation.build.a',
      kind: 'observation',
      value: 'Build output location differed in one run.',
      sourceType: 'test',
    });
    const observationB = await runtime.memory.commit({
      scope,
      canonicalKey: 'observation.build.b',
      kind: 'observation',
      value: 'Build output location differed in another run.',
      sourceType: 'test',
    });
    await runtime.memory.openConflict(scope, observationA.memoryId, observationB.memoryId, 'ambiguous_freeform', {
      reason: 'Both observations must remain visible to the primary AI.',
    });

    const expiresAt = Date.now() + 60_000;
    const first = await runtime.memory.preflight({
      scope,
      routeContextId: 'route_preflight_fixture',
      task: 'Build the project and keep output on drive F',
      context: 'Use the established build layout and avoid repeating prior cache failures.',
      routeMetadata: { toolName: 'execute_command' },
      expiresAt,
    });

    expect(first.contextId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(first.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.blocking.blocked).toBe(true);
    expect(first.blocking.guardrailMemoryIds).toContain(guardrail.memoryId);
    expect(first.blockingGuardrails.map((item) => item.memoryId)).toContain(guardrail.memoryId);
    expect(first.priorFailures.map((item) => item.memoryId)).toContain(failure.memoryId);
    expect(first.relatedDecisions.map((item) => item.memoryId)).toContain(decision.memoryId);
    expect(first.openConflicts).toHaveLength(1);
    expect(first.recalled.length).toBeGreaterThanOrEqual(3);
    expect(first.expiresAt).toBe(expiresAt);

    const persisted = await runtime.memory.getContext(scope, first.contextId);
    expect(persisted).not.toBeNull();
    expect(persisted!.routeContextId).toBe('route_preflight_fixture');
    expect(persisted!.expiresAt).toBe(expiresAt);
    expect(persisted!.resultJson).toContain(first.snapshotHash);

    const second = await runtime.memory.preflight({
      scope,
      routeContextId: 'route_preflight_fixture_2',
      task: 'Build the project and keep output on drive F',
      context: 'Use the established build layout and avoid repeating prior cache failures.',
      routeMetadata: { toolName: 'execute_command' },
      expiresAt: expiresAt + 1,
    });
    expect(second.recalled.map((item) => item.memoryId)).toEqual(first.recalled.map((item) => item.memoryId));
    expect(second.snapshotHash).toBe(first.snapshotHash);

    await runtime.memory.close();
    await runtime.memory.close();
  });

  it('keeps the default disabled memory facade inert and explicit instead of fabricating recall', async () => {
    const root = path.resolve(process.env.TEMP || process.env.TMP || os.tmpdir(), 'agent-core-preflight-disabled');
    const baseMemory = loadConfig({}, root).memory;
    const runtime = createRuntimeServices([root], path.join(root, 'capabilities'), undefined, {
      ...baseMemory,
      enabled: false,
    });
    const status = await runtime.memory.status();
    expect(status.enabled).toBe(false);
    expect(status.healthy).toBe(false);

    const result = await runtime.memory.preflight({
      scope: { principalId: 'principal-disabled' },
      routeContextId: 'route_disabled_fixture',
      task: 'do a task',
      expiresAt: Date.now() + 1_000,
    });
    expect(result.recalled).toEqual([]);
    expect(result.blocking.blocked).toBe(false);
    expect(result.blockingGuardrails).toEqual([]);
    expect(result.openConflicts).toEqual([]);
    expect(result.priorFailures).toEqual([]);
    expect(result.relatedDecisions).toEqual([]);
    await runtime.memory.close();
  });
});
