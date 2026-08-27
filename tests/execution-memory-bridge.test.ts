import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ExecutionLogStore } from '../src/execution/log-store.js';
import { ExecutionMemoryBridge, type ExecutionMemoryWriter } from '../src/execution/memory-bridge.js';
import { ExecutionService } from '../src/execution/service.js';
import { ExecutionStore } from '../src/execution/store.js';
import { MemoryService } from '../src/memory/service.js';
import type { MemoryCommitRequest, MemoryCommitResult, MemoryScope, MemoryStatus } from '../src/memory/types.js';
import { WorkspacePolicy } from '../src/runtime/workspace.js';
import { nodeShellCommand } from './helpers/platform-command.js';

const roots: string[] = [];
const executions: ExecutionService[] = [];
const memories: MemoryService[] = [];
const originalBridgeSecret = process.env.AGENT_CORE_BRIDGE_TEST_SECRET;

async function rootFixture(label: string) {
  const base = process.env.TEMP || process.env.TMP || os.tmpdir();
  const root = await mkdtemp(path.join(base, `agent-core-execution-memory-${label}-`));
  roots.push(root);
  const work = path.join(root, 'work');
  await mkdir(work, { recursive: true });
  return { root, work };
}

class SwitchableMemoryWriter implements ExecutionMemoryWriter {
  healthy = false;
  readonly commits: MemoryCommitRequest[] = [];
  readonly events: Array<Record<string, unknown>> = [];

  async status(): Promise<MemoryStatus> {
    return {
      enabled: true,
      healthy: this.healthy,
      schemaVersion: 2,
      dbPath: 'fake-memory.sqlite',
      counts: {},
      integrity: this.healthy ? 'ok' : 'degraded:test',
    };
  }

  async commit(request: MemoryCommitRequest): Promise<MemoryCommitResult> {
    if (!this.healthy) throw new Error('MEMORY_DEGRADED:test');
    this.commits.push(request);
    return {
      memoryId: `memory-${this.commits.length}`,
      revisionId: `revision-${this.commits.length}`,
      eventId: `event-${this.commits.length}`,
      revisionNo: 1,
      deduplicated: false,
      state: 'active',
    };
  }

  async recordEvent(request: any): Promise<unknown> {
    if (!this.healthy) throw new Error('MEMORY_DEGRADED:test');
    this.events.push(request);
    return { eventId: `event-${this.events.length}` };
  }
}

afterEach(async () => {
  if (originalBridgeSecret === undefined) delete process.env.AGENT_CORE_BRIDGE_TEST_SECRET;
  else process.env.AGENT_CORE_BRIDGE_TEST_SECRET = originalBridgeSecret;
  await Promise.all(executions.splice(0).map((service) => service.close().catch(() => undefined)));
  await Promise.all(memories.splice(0).map((memory) => memory.close().catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Execution-to-DMF continuity bridge', () => {
  it('exposes a bridge that can queue and replay bounded execution promotions', () => {
    expect(typeof ExecutionMemoryBridge).toBe('function');
  });

  it('promotes verified declared-artifact manifest with exact attempt provenance but never raw stdout content', async () => {
    const f = await rootFixture('verified-manifest');
    const defaults = loadConfig({}, f.root);
    const config = {
      ...defaults.execution,
      enabled: true,
      dbPath: path.join(f.root, 'runtime', 'execution', 'verified.sqlite'),
      logRoot: path.join(f.root, 'runtime', 'execution', 'runs'),
    };
    const store = new ExecutionStore();
    const writer = new SwitchableMemoryWriter();
    writer.healthy = true;
    const logs = new ExecutionLogStore(config.logRoot);
    const bridge = new ExecutionMemoryBridge(store, writer, logs);
    const service = new ExecutionService(config, new WorkspacePolicy([f.root]), { store, memoryBridge: bridge });
    executions.push(service);
    await service.open();
    const scope: MemoryScope = { principalId: 'principal-verified', projectId: f.root };
    const artifactPath = path.join(f.work, 'verified-artifact.json');
    const rawSentinel = 'RAW-STDOUT-MUST-STAY-OUT-OF-DMF';

    const created = await service.create(scope, {
      objective: 'Promote verified declared artifact manifest',
      continuityTaskId: 'continuity-task-verified-artifact',
      originRouteContextId: 'route-verified-artifact',
      nodes: [{
        id: 'A',
        purpose: 'create verified artifact',
        command: nodeShellCommand(`
          const fs = require('node:fs');
          fs.writeFileSync(${JSON.stringify(artifactPath)}, JSON.stringify({ verified: true }));
          process.stdout.write(${JSON.stringify(rawSentinel)});
        `),
        cwd: f.work,
        expectedArtifacts: [{ path: artifactPath, kind: 'file', hash: 'sha256', required: true }],
      }],
    });
    await service.start(scope, created.runId);
    const completed = await service.wait(scope, created.runId, created.lastEventSequence, { eventTypes: ['run.completed'] }, 5_000);
    expect(completed.event?.eventType).toBe('run.completed');
    await bridge.drain();

    const promoted = writer.commits.find((request) => request.canonicalKey === `execution.artifact.${created.runId}.A.1`);
    expect(promoted).toBeTruthy();
    expect(promoted).toMatchObject({
      kind: 'artifact',
      sourceType: 'execution_verified_evidence',
      sourceRef: created.runId,
      metadata: {
        taskId: 'continuity-task-verified-artifact',
        runId: created.runId,
        nodeId: 'A',
        attemptNo: 1,
        resultRef: expect.stringMatching(/attempt-001\.result\.json$/),
      },
      value: {
        runId: created.runId,
        nodeId: 'A',
        attemptNo: 1,
        resultVersion: 2,
        processState: 'succeeded',
        evidenceState: 'verified',
        artifacts: [expect.objectContaining({
          path: artifactPath,
          kind: 'file',
          required: true,
          exists: true,
          verification: 'verified',
          size: expect.any(Number),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        })],
      },
    });
    expect(JSON.stringify(promoted)).not.toContain(rawSentinel);
  }, 10_000);

  it('fails closed instead of promoting declared-artifact success when its durable v2 marker is missing', async () => {
    const f = await rootFixture('missing-marker');
    const defaults = loadConfig({}, f.root);
    const config = {
      ...defaults.execution,
      enabled: true,
      dbPath: path.join(f.root, 'runtime', 'execution', 'missing-marker.sqlite'),
      logRoot: path.join(f.root, 'runtime', 'execution', 'runs'),
    };
    const store = new ExecutionStore();
    await store.open({ dbPath: config.dbPath });
    const writer = new SwitchableMemoryWriter();
    writer.healthy = true;
    const bridge = new ExecutionMemoryBridge(store, writer, new ExecutionLogStore(config.logRoot));
    const scope: MemoryScope = { principalId: 'principal-missing-marker', projectId: f.root };
    const run = await store.createRun(scope, {
      objective: 'Missing marker fail-closed fixture',
      continuityTaskId: 'continuity-task-missing-marker',
      originRouteContextId: 'route-missing-marker',
      maxConcurrency: 1,
    });
    const artifactPath = path.join(f.work, 'expected.txt');
    await store.persistGraph(scope, run.runId, [{
      id: 'A', purpose: 'declared artifact', command: nodeShellCommand("process.stdout.write('ok')"), cwd: f.work,
      dependsOn: [], timeoutMs: 10_000, continueOnFailure: false,
      expectedArtifacts: [{ path: artifactPath, kind: 'file', required: true }],
    }]);
    const paths = new ExecutionLogStore(config.logRoot).paths(run.runId, 'A', 1);
    await store.createAttempt(scope, run.runId, 'A', 'attempt-missing-marker', 1, paths);
    await store.completeAttempt(scope, {
      version: 2,
      runId: run.runId,
      nodeId: 'A',
      attemptId: 'attempt-missing-marker',
      attemptNo: 1,
      state: 'succeeded',
      processState: 'succeeded',
      evidenceState: 'verified',
      evidence: { verification: 'verified', artifacts: [] },
      startedAt: 1,
      finishedAt: 2,
      exitCode: 0,
      signal: null,
      stdoutBytes: 2,
      stderrBytes: 0,
      stdoutSha256: 'a'.repeat(64),
      stderrSha256: 'b'.repeat(64),
    });
    const event = await store.appendEvent(scope, run.runId, 'node.succeeded', {
      nodeId: 'A', attemptId: 'attempt-missing-marker', payload: { attemptNo: 1, exitCode: 0 },
    });

    expect(await bridge.handlePersistedEvent(scope, event)).toEqual({ promoted: 0, queued: 0 });
    expect(writer.commits).toHaveLength(0);
    await store.close();
  });

  it('promotes only bounded parsed facts and never parsed error samples or raw secret text', async () => {
    const f = await rootFixture('parsed-evidence');
    const defaults = loadConfig({}, f.root);
    const config = {
      ...defaults.execution,
      enabled: true,
      dbPath: path.join(f.root, 'runtime', 'execution', 'parsed.sqlite'),
      logRoot: path.join(f.root, 'runtime', 'execution', 'runs'),
    };
    const store = new ExecutionStore();
    const writer = new SwitchableMemoryWriter();
    writer.healthy = true;
    const bridge = new ExecutionMemoryBridge(store, writer, new ExecutionLogStore(config.logRoot));
    const service = new ExecutionService(config, new WorkspacePolicy([f.root]), { store, memoryBridge: bridge });
    executions.push(service);
    await service.open();
    const scope: MemoryScope = { principalId: 'principal-parsed', projectId: f.root };
    const secret = 'PARSED-BRIDGE-SECRET-123456789';
    const created = await service.create(scope, {
      objective: 'promote safe parsed test evidence',
      continuityTaskId: 'continuity-task-parsed',
      originRouteContextId: 'route-parsed',
      nodes: [{
        id: 'A', purpose: 'emit test summary',
        command: nodeShellCommand(`
          process.stdout.write('Test Files  1 passed (1)\\nTests  8 passed | 1 skipped (9)\\nPERF wake_ms=4.25\\n');
          process.stderr.write('error: token=${secret} diagnostic sample\\n');
        `),
        cwd: f.work,
      }],
    });
    await service.start(scope, created.runId);
    await service.wait(scope, created.runId, created.lastEventSequence, { eventTypes: ['run.completed'] }, 5_000);
    await bridge.drain();

    const promoted = writer.commits.find((request) => request.canonicalKey === `execution.artifact.${created.runId}.A.1`);
    expect(promoted).toBeTruthy();
    expect(promoted?.value).toMatchObject({
      parsedEvidence: {
        parserVersion: '1.0.0',
        testResults: { passed: 8, failed: 0, skipped: 1 },
        performanceMetrics: { wake_ms: 4.25 },
        errorPatterns: [{ type: 'generic', count: 1 }],
      },
    });
    const serialized = JSON.stringify(promoted);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('diagnostic sample');
    expect(serialized).not.toContain('"sample"');
  }, 10_000);

  it('queues a failed-node promotion while DMF is degraded, then replays it idempotently when DMF recovers', async () => {
    const f = await rootFixture('queue');
    const executionConfig = { ...loadConfig({}, f.root).execution, enabled: true, dbPath: path.join(f.root, 'runtime', 'execution', 'queue.sqlite') };
    const store = new ExecutionStore();
    await store.open({ dbPath: executionConfig.dbPath });
    const writer = new SwitchableMemoryWriter();
    const bridge = new ExecutionMemoryBridge(store, writer);
    const scope: MemoryScope = { principalId: 'principal-queue', projectId: f.root };
    const run = await store.createRun(scope, {
      objective: 'Queue failed execution evidence',
      continuityTaskId: 'continuity-task-queue',
      originRouteContextId: 'route-queue',
      maxConcurrency: 1,
    });
    await store.persistGraph(scope, run.runId, [{
      id: 'A', purpose: 'fail A', command: "Write-Output $env:SAFE_REF; exit 9", cwd: f.work,
      dependsOn: [], timeoutMs: 10_000, continueOnFailure: false,
    }]);
    const paths = {
      directory: path.join(f.root, 'evidence'),
      stdoutPath: path.join(f.root, 'evidence', 'attempt-001.stdout.log'),
      stderrPath: path.join(f.root, 'evidence', 'attempt-001.stderr.log'),
      resultPath: path.join(f.root, 'evidence', 'attempt-001.result.json'),
    };
    await store.createAttempt(scope, run.runId, 'A', 'attempt-queue', 1, paths);
    await store.completeAttempt(scope, {
      version: 1, runId: run.runId, nodeId: 'A', attemptId: 'attempt-queue', attemptNo: 1,
      state: 'failed', startedAt: 1, finishedAt: 2, exitCode: 9, signal: null,
      stdoutBytes: 12, stderrBytes: 7, stdoutSha256: 'a'.repeat(64), stderrSha256: 'b'.repeat(64),
    });
    const event = await store.appendEvent(scope, run.runId, 'node.failed', {
      nodeId: 'A', attemptId: 'attempt-queue', payload: { attemptNo: 1, exitCode: 9 },
    });

    const queued = await bridge.handlePersistedEvent(scope, event);
    expect(queued).toMatchObject({ queued: 1, promoted: 0 });
    expect(writer.commits).toHaveLength(0);
    expect(await store.countMemorySyncQueue(scope)).toBe(1);

    writer.healthy = true;
    const replayed = await bridge.replay(scope);
    expect(replayed).toMatchObject({ synced: 1, failed: 0 });
    expect(writer.commits).toHaveLength(1);
    expect(writer.commits[0]).toMatchObject({ kind: 'failure', canonicalKey: expect.stringMatching(/^failure\.execution\./) });
    expect(JSON.stringify(writer.commits[0])).not.toContain('Write-Output');
    expect(await store.countMemorySyncQueue(scope)).toBe(0);

    const replayAgain = await bridge.replay(scope);
    expect(replayAgain).toMatchObject({ synced: 0, failed: 0 });
    expect(writer.commits).toHaveLength(1);
    await store.close();
  });

  it('promotes real failed execution evidence without copying a synthetic secret from raw stderr into DMF/search/export', async () => {
    const f = await rootFixture('secret');
    const defaults = loadConfig({}, f.root);
    const memory = new MemoryService({ ...defaults.memory, enabled: true, dbPath: path.join(f.root, 'runtime', 'memory', 'bridge.sqlite') });
    memories.push(memory);
    const store = new ExecutionStore();
    const bridge = new ExecutionMemoryBridge(store, memory);
    const service = new ExecutionService(
      {
        ...defaults.execution,
        enabled: true,
        dbPath: path.join(f.root, 'runtime', 'execution', 'bridge.sqlite'),
        logRoot: path.join(f.root, 'runtime', 'execution', 'runs'),
      },
      new WorkspacePolicy([f.root]),
      { store, memoryBridge: bridge },
    );
    executions.push(service);
    await service.open();
    const scope: MemoryScope = { principalId: 'principal-secret', projectId: f.root };
    const turn = await memory.beginContinuityTurn(scope, 'route-secret', 'Bridge secret audit task', undefined, { objective: 'Bridge secret audit task' });
    const secret = 'bridge-secret-sentinel-987654321';
    process.env.AGENT_CORE_BRIDGE_TEST_SECRET = secret;

    const created = await service.create(scope, {
      objective: 'Fail while emitting secret only to raw stderr',
      continuityTaskId: turn.taskId,
      originRouteContextId: 'route-secret',
      nodes: [{
        id: 'A', purpose: 'emit synthetic secret and fail',
        command: nodeShellCommand("process.stderr.write(process.env.AGENT_CORE_BRIDGE_TEST_SECRET ?? ''); process.exitCode = 7;"),
        cwd: f.work,
      }],
    });
    await service.start(scope, created.runId);
    const waited = await service.wait(scope, created.runId, created.lastEventSequence, { eventTypes: ['run.failed'] }, 5_000);
    expect(waited.event?.eventType).toBe('run.failed');

    const raw = await service.readLog(scope, created.runId, 'A', 1, 'stderr', 0, 4096);
    expect(raw.data).toContain(secret);

    await bridge.flush(scope);
    const search = await memory.search({ scope, query: `execution failure ${created.runId} A`, limit: 20 });
    expect(search.hits.some((hit) => hit.kind === 'failure')).toBe(true);
    expect(JSON.stringify(search)).not.toContain(secret);
    const exported = await memory.export(scope, 100);
    expect(JSON.stringify(exported)).not.toContain(secret);
    for (const candidate of [memory.config.dbPath, `${memory.config.dbPath}-wal`, `${memory.config.dbPath}-shm`]) {
      const bytes = await readFile(candidate).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return Buffer.alloc(0);
        throw error;
      });
      expect(bytes.includes(Buffer.from(secret, 'utf8'))).toBe(false);
    }
    expect((await memory.getContinuityTask(scope, turn.taskId))?.status).toBe('running');

    const processCheckpoint = search.hits.find((hit) => hit.canonicalKey.includes('process_checkpoint'));
    expect(processCheckpoint ?? (await memory.search({ scope, query: `process checkpoint ${created.runId}`, limit: 20 })).hits[0]).toBeTruthy();
  }, 10_000);

  it('links direct runs to a local continuity task identifier even when the caller did not supply one', async () => {
    const f = await rootFixture('link');
    const defaults = loadConfig({}, f.root);
    const service = new ExecutionService(
      { ...defaults.execution, enabled: true, dbPath: path.join(f.root, 'execution.sqlite') },
      new WorkspacePolicy([f.root]),
    );
    executions.push(service);
    await service.open();
    const created = await service.create({ principalId: 'principal-link', projectId: f.root }, {
      objective: 'Every run gets a continuity identifier',
      nodes: [{ id: 'A', purpose: 'A', command: "Write-Output 'A'", cwd: f.work }],
    });
    expect(created.continuityTaskId).toMatch(/^[0-9a-f-]{36}$/i);
  });
});
