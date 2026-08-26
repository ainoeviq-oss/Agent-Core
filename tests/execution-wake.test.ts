import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { ValidatedExecutionNode } from '../src/execution/dag.js';
import type { ExecutionResultMarker } from '../src/execution/log-store.js';
import type { ExecutionRunHandle } from '../src/execution/runner.js';
import type { ExecutionRunnerLike } from '../src/execution/scheduler.js';
import { ExecutionService } from '../src/execution/service.js';
import { EXECUTION_EVENT_TYPES } from '../src/execution/wake.js';
import type { ExecutionScope } from '../src/execution/types.js';
import { WorkspacePolicy } from '../src/runtime/workspace.js';
import { nodeShellCommand } from './helpers/platform-command.js';

const roots: string[] = [];

function terminal(runId: string, nodeId: string, attemptId: string, attemptNo: number, state: ExecutionResultMarker['state']): ExecutionResultMarker {
  const now = Date.now();
  return {
    version: 1, runId, nodeId, attemptId, attemptNo, state,
    startedAt: now - 1, finishedAt: now,
    exitCode: state === 'succeeded' ? 0 : 8,
    signal: null,
    stdoutBytes: 0, stderrBytes: 0,
    stdoutSha256: '0'.repeat(64), stderrSha256: '0'.repeat(64),
  };
}

class ControlledRunner implements ExecutionRunnerLike {
  readonly starts: Array<{ runId: string; node: ValidatedExecutionNode; attemptId: string; attemptNo: number }> = [];
  private readonly pending = new Map<string, (marker: ExecutionResultMarker) => void>();

  async start(runId: string, node: ValidatedExecutionNode, attemptId: string, attemptNo: number): Promise<ExecutionRunHandle> {
    this.starts.push({ runId, node, attemptId, attemptNo });
    let resolve!: (marker: ExecutionResultMarker) => void;
    const completion = new Promise<ExecutionResultMarker>((res) => { resolve = res; });
    this.pending.set(`${runId}/${node.id}/${attemptNo}`, resolve);
    return {
      pid: 20_000 + this.starts.length,
      completion,
      terminate: (state = 'cancelled') => resolve(terminal(runId, node.id, attemptId, attemptNo, state)),
    };
  }

  complete(runId: string, nodeId: string, attemptNo: number, state: ExecutionResultMarker['state']) {
    const key = `${runId}/${nodeId}/${attemptNo}`;
    const resolve = this.pending.get(key);
    if (!resolve) throw new Error(`No pending ${key}`);
    const started = this.starts.find((item) => item.runId === runId && item.node.id === nodeId && item.attemptNo === attemptNo)!;
    this.pending.delete(key);
    resolve(terminal(runId, nodeId, started.attemptId, attemptNo, state));
  }
}

async function fixture(label: string, runner = new ControlledRunner()) {
  const base = process.env.TEMP || process.env.TMP || os.tmpdir();
  const root = await mkdtemp(path.join(base, `agent-core-execution-wake-${label}-`));
  roots.push(root);
  const work = path.join(root, 'work');
  await mkdir(work, { recursive: true });
  const baseConfig = loadConfig({}, root).execution;
  const config = {
    ...baseConfig,
    enabled: true,
    dbPath: path.join(root, 'runtime', 'execution', 'wake.sqlite'),
    logRoot: path.join(root, 'runtime', 'execution', 'runs'),
    maxConcurrency: 4,
    waitMaxMs: 1000,
  };
  const service = new ExecutionService(config, new WorkspacePolicy([root]), { runner });
  await service.open();
  return { root, work, config, service, runner, scope: { principalId: 'principal-wake', projectId: root } satisfies ExecutionScope };
}

async function realFixture(label: string) {
  const base = process.env.TEMP || process.env.TMP || os.tmpdir();
  const root = await mkdtemp(path.join(base, `agent-core-execution-wake-real-${label}-`));
  roots.push(root);
  const work = path.join(root, 'work');
  await mkdir(work, { recursive: true });
  const baseConfig = loadConfig({}, root).execution;
  const config = {
    ...baseConfig,
    enabled: true,
    dbPath: path.join(root, 'runtime', 'execution', 'wake.sqlite'),
    logRoot: path.join(root, 'runtime', 'execution', 'runs'),
    maxConcurrency: 2,
    waitMaxMs: 5_000,
  };
  const service = new ExecutionService(config, new WorkspacePolicy([root]));
  await service.open();
  return { root, work, config, service, scope: { principalId: 'principal-wake-real', projectId: root } satisfies ExecutionScope };
}

async function eventually(assertion: () => void | Promise<void>, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try { await assertion(); return; }
    catch (error) { lastError = error; await new Promise((resolve) => setImmediate(resolve)); }
  }
  throw lastError;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('persisted execution event journal and event-driven wake', () => {
  it('defines the complete event vocabulary and persists monotonic run.created/node.queued events before wait can observe them', async () => {
    expect(EXECUTION_EVENT_TYPES).toEqual([
      'run.created', 'run.started', 'node.queued', 'node.ready', 'node.started',
      'node.output_available', 'node.succeeded', 'node.failed', 'node.blocked',
      'node.interrupted', 'node.retry_started', 'node.cancelled', 'run.completed',
      'run.failed', 'run.blocked', 'run.interrupted', 'run.cancelled',
    ]);
    const f = await fixture('created');
    try {
      const created = await f.service.create(f.scope, {
        objective: 'event creation fixture',
        nodes: [
          { id: 'B', purpose: 'B', command: "Write-Output 'B'", cwd: f.work },
          { id: 'A', purpose: 'A', command: "Write-Output 'A'", cwd: f.work },
        ],
      });
      const events = await f.service.events(f.scope, created.runId, 0);
      expect(events.map((event) => event.eventType)).toEqual(['run.created', 'node.queued', 'node.queued']);
      expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
      expect(events.slice(1).map((event) => event.nodeId)).toEqual(['A', 'B']);
      expect(created.lastEventSequence).toBe(3);

      const immediate = await f.service.wait(f.scope, created.runId, 0, undefined, 500);
      expect(immediate.timedOut).toBe(false);
      expect(immediate.event).toEqual(events[0]);
      expect(immediate.lastEventSequence).toBe(3);
    } finally {
      await f.service.close();
    }
  });

  it('wakes on persisted A completion while B remains running, with no DB polling loop required by the caller', async () => {
    const runner = new ControlledRunner();
    const f = await fixture('completion', runner);
    try {
      const created = await f.service.create(f.scope, {
        objective: 'wake on A completion',
        nodes: [
          { id: 'C', purpose: 'C', command: "Write-Output 'C'", cwd: f.work, dependsOn: ['A'] },
          { id: 'B', purpose: 'B', command: "Write-Output 'B'", cwd: f.work },
          { id: 'A', purpose: 'A', command: "Write-Output 'A'", cwd: f.work },
        ],
      });
      await f.service.start(f.scope, created.runId);
      const running = await f.service.status(f.scope, created.runId);
      const afterSequence = running!.lastEventSequence;
      expect(running?.nodes.filter((node) => node.state === 'running').map((node) => node.nodeId).sort()).toEqual(['A', 'B']);

      const waiting = f.service.wait(
        f.scope,
        created.runId,
        afterSequence,
        { eventTypes: ['node.succeeded'], nodeIds: ['A'] },
        1000,
      );
      runner.complete(created.runId, 'A', 1, 'succeeded');
      const woke = await waiting;
      expect(woke.timedOut).toBe(false);
      expect(woke.event).toMatchObject({ eventType: 'node.succeeded', nodeId: 'A' });
      const persisted = await f.service.events(f.scope, created.runId, afterSequence);
      expect(persisted.some((event) => event.sequence === woke.event!.sequence && event.eventType === 'node.succeeded')).toBe(true);
      expect(woke.state.nodes.find((node) => node.nodeId === 'B')?.state).toBe('running');

      await eventually(async () => expect((await f.service.status(f.scope, created.runId))?.nodes.find((node) => node.nodeId === 'C')?.state).toBe('running'));
      runner.complete(created.runId, 'C', 1, 'succeeded');
      runner.complete(created.runId, 'B', 1, 'succeeded');
      await eventually(async () => expect((await f.service.status(f.scope, created.runId))?.state).toBe('completed'));
    } finally {
      await f.service.close();
    }
  });

  it('returns current graph state on timeout without fabricating an event or advancing sequence', async () => {
    const f = await fixture('timeout');
    try {
      const created = await f.service.create(f.scope, {
        objective: 'timeout fixture',
        nodes: [{ id: 'A', purpose: 'A', command: "Write-Output 'A'", cwd: f.work }],
      });
      const before = await f.service.status(f.scope, created.runId);
      const result = await f.service.wait(f.scope, created.runId, before!.lastEventSequence, undefined, 30);
      expect(result.timedOut).toBe(true);
      expect(result.event).toBeNull();
      expect(result.lastEventSequence).toBe(before!.lastEventSequence);
      expect(result.state).toEqual(before);
      expect((await f.service.events(f.scope, created.runId, before!.lastEventSequence))).toEqual([]);
    } finally {
      await f.service.close();
    }
  });

  it('coalesces rapid output-available notifications for the same run/node instead of creating an event storm', async () => {
    const f = await fixture('output');
    try {
      const created = await f.service.create(f.scope, {
        objective: 'output coalescing fixture',
        nodes: [{ id: 'A', purpose: 'A', command: "Write-Output 'A'", cwd: f.work }],
      });
      for (let index = 0; index < 20; index++) {
        await f.service.recordOutputAvailable(f.scope, created.runId, 'A', { chunkIndex: index });
      }
      const events = await f.service.events(f.scope, created.runId, 0);
      expect(events.filter((event) => event.eventType === 'node.output_available')).toHaveLength(1);
      const sequences = events.map((event) => event.sequence);
      expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
      expect(new Set(sequences).size).toBe(sequences.length);
    } finally {
      await f.service.close();
    }
  });

  it('wires real runner stdout/stderr availability into persisted coalesced wake events without raw log content', async () => {
    const f = await realFixture('runner-output');
    try {
      const command = nodeShellCommand(`
        process.stdout.write('FIRST-CHUNK');
        process.stderr.write('ERR-CHUNK');
        setTimeout(() => process.stdout.write('SECOND-CHUNK'), 350);
        setTimeout(() => {}, 650);
      `);
      const created = await f.service.create(f.scope, {
        objective: 'runner output availability fixture',
        nodes: [{ id: 'A', purpose: 'emit bounded output', command, cwd: f.work }],
      });
      const waiting = f.service.wait(
        f.scope,
        created.runId,
        created.lastEventSequence,
        { eventTypes: ['node.output_available'], nodeIds: ['A'] },
        5_000,
      );
      await f.service.start(f.scope, created.runId);
      const woke = await waiting;
      expect(woke.timedOut).toBe(false);
      expect(woke.event).toMatchObject({
        eventType: 'node.output_available',
        nodeId: 'A',
        payload: {
          stream: expect.stringMatching(/^(stdout|stderr)$/),
          offset: expect.any(Number),
          nextOffset: expect.any(Number),
          chunkBytes: expect.any(Number),
        },
      });
      expect(JSON.stringify(woke.event?.payload)).not.toContain('FIRST-CHUNK');
      expect(JSON.stringify(woke.event?.payload)).not.toContain('ERR-CHUNK');

      const terminal = await f.service.wait(
        f.scope,
        created.runId,
        woke.lastEventSequence,
        { eventTypes: ['run.completed'] },
        5_000,
      );
      expect(terminal.event?.eventType).toBe('run.completed');
      const events = await f.service.events(f.scope, created.runId, 0);
      const outputEvents = events.filter((event) => event.eventType === 'node.output_available');
      expect(outputEvents.length).toBeGreaterThanOrEqual(1);
      expect(outputEvents.length).toBeLessThanOrEqual(3);
      expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
      expect(events.findIndex((event) => event.eventType === 'node.output_available'))
        .toBeLessThan(events.findIndex((event) => event.eventType === 'node.succeeded'));
    } finally {
      await f.service.close();
    }
  }, 10_000);

  it('proves A/B concurrent wake -> inspect A evidence -> re-arm after latest sequence -> inspect B evidence', async () => {
    const f = await realFixture('staged-ab');
    try {
      const artifactA = path.join(f.work, 'artifact-a.json');
      const artifactB = path.join(f.work, 'artifact-b.json');
      const commandA = nodeShellCommand(`
        const fs = require('node:fs');
        setTimeout(() => fs.writeFileSync(${JSON.stringify(artifactA)}, JSON.stringify({ node: 'A', ok: true })), 150);
      `);
      const commandB = nodeShellCommand(`
        const fs = require('node:fs');
        setTimeout(() => fs.writeFileSync(${JSON.stringify(artifactB)}, JSON.stringify({ node: 'B', ok: true })), 800);
      `);
      const created = await f.service.create(f.scope, {
        objective: 'staged A/B wake evidence fixture',
        maxConcurrency: 2,
        nodes: [
          {
            id: 'B', purpose: 'slower independent B', command: commandB, cwd: f.work,
            expectedArtifacts: [{ path: artifactB, kind: 'file', hash: 'sha256', required: true }],
          },
          {
            id: 'A', purpose: 'faster independent A', command: commandA, cwd: f.work,
            expectedArtifacts: [{ path: artifactA, kind: 'file', hash: 'sha256', required: true }],
          },
        ],
      });
      const firstWait = f.service.wait(
        f.scope,
        created.runId,
        created.lastEventSequence,
        { eventTypes: ['node.succeeded'], nodeIds: ['A'] },
        5_000,
      );
      const started = await f.service.start(f.scope, created.runId);
      expect(started.nodes.filter((node) => node.state === 'running').map((node) => node.nodeId).sort())
        .toEqual(['A', 'B']);

      const wokeA = await firstWait;
      expect(wokeA.timedOut).toBe(false);
      expect(wokeA.event).toMatchObject({ eventType: 'node.succeeded', nodeId: 'A' });
      expect(wokeA.state.nodes.find((node) => node.nodeId === 'B')?.state).toBe('running');
      expect(wokeA.state.evidence.nodes.find((node) => node.nodeId === 'A')).toMatchObject({
        processState: 'succeeded',
        evidenceState: 'verified',
        resultVersion: 2,
        artifacts: [expect.objectContaining({
          path: artifactA,
          verification: 'verified',
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        })],
      });
      const latestAfterA = wokeA.lastEventSequence;
      expect(latestAfterA).toBeGreaterThan(wokeA.event!.sequence - 1);

      const wokeB = await f.service.wait(
        f.scope,
        created.runId,
        latestAfterA,
        { eventTypes: ['node.succeeded'], nodeIds: ['B'] },
        5_000,
      );
      expect(wokeB.timedOut).toBe(false);
      expect(wokeB.event).toMatchObject({ eventType: 'node.succeeded', nodeId: 'B' });
      expect(wokeB.event!.sequence).toBeGreaterThan(latestAfterA);
      expect(wokeB.state.evidence.nodes.map((node) => node.nodeId)).toEqual(['A', 'B']);
      for (const evidence of wokeB.state.evidence.nodes) {
        expect(evidence).toMatchObject({ processState: 'succeeded', evidenceState: 'verified', resultVersion: 2 });
        expect(evidence.artifacts).toHaveLength(1);
        expect(evidence.artifacts[0]).toMatchObject({
          verification: 'verified',
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
      }

      const completed = await f.service.wait(
        f.scope,
        created.runId,
        wokeB.lastEventSequence,
        { eventTypes: ['run.completed'] },
        5_000,
      );
      expect(completed.event?.eventType).toBe('run.completed');
      expect(completed.state.state).toBe('completed');
      expect(completed.state.evidence.verification).toBe('verified');
      expect(completed.state.evidence.nodes.map((node) => node.nodeId)).toEqual(['A', 'B']);
    } finally {
      await f.service.close();
    }
  }, 10_000);

  it('emits retry and terminal run events with globally monotonic per-run sequence values', async () => {
    const runner = new ControlledRunner();
    const f = await fixture('retry-events', runner);
    try {
      const created = await f.service.create(f.scope, {
        objective: 'retry event fixture',
        nodes: [{ id: 'A', purpose: 'A', command: "Write-Output 'A'", cwd: f.work }],
      });
      await f.service.start(f.scope, created.runId);
      runner.complete(created.runId, 'A', 1, 'failed');
      await eventually(async () => expect((await f.service.status(f.scope, created.runId))?.state).toBe('failed'));
      await f.service.retry(f.scope, created.runId, 'A');
      runner.complete(created.runId, 'A', 2, 'succeeded');
      await eventually(async () => expect((await f.service.status(f.scope, created.runId))?.state).toBe('completed'));

      const events = await f.service.events(f.scope, created.runId, 0);
      expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
      expect(events.map((event) => event.eventType)).toContain('node.retry_started');
      expect(events.map((event) => event.eventType)).toContain('run.failed');
      expect(events.at(-1)?.eventType).toBe('run.completed');
    } finally {
      await f.service.close();
    }
  });
});
