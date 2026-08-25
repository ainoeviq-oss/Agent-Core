import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadConfig } from '../dist/config.js';
import { validateExecutionDag } from '../dist/execution/dag.js';
import { ExecutionService } from '../dist/execution/service.js';
import { WorkspacePolicy } from '../dist/runtime/workspace.js';

const DEFAULT_SAMPLES = 20;
const DEFAULT_WARMUP = 3;
const DEFAULT_DAG_TARGET_MS = 50;
const DEFAULT_DISPATCH_TARGET_MS = 100;
const DEFAULT_WAKE_TARGET_MS = 250;
const NODE_COUNT = 128;
const MAX_CONCURRENCY = 4;

function parseArgs(argv) {
  const result = {
    samples: DEFAULT_SAMPLES,
    warmup: DEFAULT_WARMUP,
    dagTargetMs: DEFAULT_DAG_TARGET_MS,
    dispatchTargetMs: DEFAULT_DISPATCH_TARGET_MS,
    wakeTargetMs: DEFAULT_WAKE_TARGET_MS,
    keep: false,
  };
  for (const arg of argv) {
    if (arg.startsWith('--samples=')) result.samples = Number(arg.slice('--samples='.length));
    else if (arg.startsWith('--warmup=')) result.warmup = Number(arg.slice('--warmup='.length));
    else if (arg.startsWith('--dag-target-ms=')) result.dagTargetMs = Number(arg.slice('--dag-target-ms='.length));
    else if (arg.startsWith('--dispatch-target-ms=')) result.dispatchTargetMs = Number(arg.slice('--dispatch-target-ms='.length));
    else if (arg.startsWith('--wake-target-ms=')) result.wakeTargetMs = Number(arg.slice('--wake-target-ms='.length));
    else if (arg === '--keep') result.keep = true;
  }
  if (!Number.isInteger(result.samples) || result.samples < 5 || result.samples > 200) throw new Error('--samples must be 5..200');
  if (!Number.isInteger(result.warmup) || result.warmup < 0 || result.warmup > 50) throw new Error('--warmup must be 0..50');
  for (const [name, value] of [['dagTargetMs', result.dagTargetMs], ['dispatchTargetMs', result.dispatchTargetMs], ['wakeTargetMs', result.wakeTargetMs]]) {
    if (!(value > 0 && Number.isFinite(value))) throw new Error(`${name} must be positive`);
  }
  return result;
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1));
  return ordered[index];
}

function summarize(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  return {
    samples: values.length,
    minMs: Number((ordered[0] ?? 0).toFixed(3)),
    meanMs: Number(mean.toFixed(3)),
    p50Ms: Number(percentile(values, 0.50).toFixed(3)),
    p95Ms: Number(percentile(values, 0.95).toFixed(3)),
    maxMs: Number((ordered.at(-1) ?? 0).toFixed(3)),
  };
}

async function timeSamples(operation, samples, warmup) {
  for (let index = 0; index < warmup; index += 1) await operation(index, true);
  const values = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    await operation(index, false);
    values.push(performance.now() - started);
  }
  return summarize(values);
}

function marker(runId, nodeId, attemptId, attemptNo, state = 'succeeded') {
  const now = Date.now();
  return {
    version: 1,
    runId,
    nodeId,
    attemptId,
    attemptNo,
    state,
    startedAt: now - 1,
    finishedAt: now,
    exitCode: state === 'succeeded' ? 0 : 1,
    signal: null,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutSha256: '0'.repeat(64),
    stderrSha256: '0'.repeat(64),
  };
}

class ControlledRunner {
  starts = [];
  pending = new Map();
  active = 0;
  maxActive = 0;

  async start(runId, node, attemptId, attemptNo) {
    this.starts.push({ runId, nodeId: node.id, attemptId, attemptNo });
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    let settled = false;
    let resolve;
    const completion = new Promise((res) => { resolve = res; });
    const settle = (state) => {
      if (settled) return;
      settled = true;
      this.active = Math.max(0, this.active - 1);
      this.pending.delete(`${runId}/${node.id}/${attemptNo}`);
      resolve(marker(runId, node.id, attemptId, attemptNo, state));
    };
    this.pending.set(`${runId}/${node.id}/${attemptNo}`, settle);
    return {
      pid: 40_000 + this.starts.length,
      completion,
      terminate: (state = 'cancelled') => settle(state),
    };
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = await mkdtemp(path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), 'agent-core-execution-benchmark-'));
  const work = path.join(root, 'work');
  await mkdir(work, { recursive: true });
  const workspace = new WorkspacePolicy([root]);
  const base = loadConfig({}, root).execution;
  const runner = new ControlledRunner();
  const service = new ExecutionService({
    ...base,
    enabled: true,
    dbPath: path.join(root, 'runtime', 'execution', 'benchmark.sqlite'),
    logRoot: path.join(root, 'runtime', 'execution', 'runs'),
    maxConcurrency: MAX_CONCURRENCY,
    maxNodes: NODE_COUNT,
    waitMaxMs: 60_000,
  }, workspace, { runner });
  let keep = options.keep;

  try {
    await service.open();
    const scope = { principalId: 'benchmark-execution-principal', projectId: root };
    const chainNodes = Array.from({ length: NODE_COUNT }, (_, index) => ({
      id: `N${String(index).padStart(3, '0')}`,
      purpose: `benchmark node ${index}`,
      command: `Write-Output '${index}'`,
      cwd: work,
      ...(index === 0 ? {} : { dependsOn: [`N${String(index - 1).padStart(3, '0')}`] }),
    }));
    const independentNodes = Array.from({ length: NODE_COUNT }, (_, index) => ({
      id: `N${String(index).padStart(3, '0')}`,
      purpose: `benchmark node ${index}`,
      command: `Write-Output '${index}'`,
      cwd: work,
    }));

    let firstOrder;
    const dag = await timeSamples(async () => {
      const validated = await validateExecutionDag(chainNodes, { workspace, maxNodes: NODE_COUNT });
      if (!firstOrder) firstOrder = validated.topologicalOrder.join('|');
      else if (validated.topologicalOrder.join('|') !== firstOrder) throw new Error('DAG ordering changed for identical input');
    }, options.samples, options.warmup);

    const dispatchRuns = [];
    for (let index = 0; index < options.warmup + options.samples; index += 1) {
      dispatchRuns.push(await service.create(scope, {
        objective: `dispatch prepared ${index}`,
        maxConcurrency: MAX_CONCURRENCY,
        nodes: independentNodes,
      }));
    }
    const dispatchValues = [];
    for (let index = 0; index < dispatchRuns.length; index += 1) {
      const created = dispatchRuns[index];
      const beforeStarts = runner.starts.length;
      const started = performance.now();
      await service.start(scope, created.runId);
      const elapsed = performance.now() - started;
      const launched = runner.starts.slice(beforeStarts).filter((item) => item.runId === created.runId);
      if (launched.length !== MAX_CONCURRENCY) throw new Error(`Expected ${MAX_CONCURRENCY} initial launches, received ${launched.length}`);
      if (runner.active > MAX_CONCURRENCY || runner.maxActive > MAX_CONCURRENCY) throw new Error('Configured max concurrency was exceeded');
      if (index >= options.warmup) dispatchValues.push(elapsed);
      await service.cancel(scope, created.runId);
    }
    const dispatch = summarize(dispatchValues);

    let getEventsReads = 0;
    const originalGetEvents = service.store.getEvents.bind(service.store);
    service.store.getEvents = async (...args) => {
      getEventsReads += 1;
      return originalGetEvents(...args);
    };
    const wake = await timeSamples(async (index, warmup) => {
      const created = await service.create(scope, {
        objective: `wake ${warmup ? 'warmup' : 'sample'} ${index}`,
        nodes: [{ id: 'A', purpose: 'wake A', command: "Write-Output 'A'", cwd: work }],
      });
      const readsBefore = getEventsReads;
      const waiting = service.wait(
        scope,
        created.runId,
        created.lastEventSequence,
        { eventTypes: ['node.output_available'], nodeIds: ['A'] },
        2_000,
      );
      await new Promise((resolve) => setImmediate(resolve));
      await service.journal.record(scope, created.runId, 'node.output_available', { nodeId: 'A', payload: { index } });
      const result = await waiting;
      if (!result.event || result.event.eventType !== 'node.output_available') throw new Error('Wake did not return the persisted event');
      const reads = getEventsReads - readsBefore;
      if (reads > 2) throw new Error(`Wake performed ${reads} event queries; busy polling is not allowed`);
    }, options.samples, options.warmup);

    const result = {
      benchmark: 'agent-core-deterministic-execution',
      startedAt: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      root: options.keep ? root : undefined,
      options,
      nodeCount: NODE_COUNT,
      maxConcurrency: MAX_CONCURRENCY,
      dagValidation: { ...dag, targetP95Ms: options.dagTargetMs, passed: dag.p95Ms < options.dagTargetMs },
      readyDispatch: { ...dispatch, targetP95Ms: options.dispatchTargetMs, passed: dispatch.p95Ms < options.dispatchTargetMs },
      wakeDelivery: { ...wake, targetP95Ms: options.wakeTargetMs, passed: wake.p95Ms < options.wakeTargetMs, maxEventQueriesPerWait: 2 },
      maxObservedConcurrency: runner.maxActive,
      concurrencyPassed: runner.maxActive <= MAX_CONCURRENCY,
    };
    result.success = result.dagValidation.passed && result.readyDispatch.passed && result.wakeDelivery.passed && result.concurrencyPassed;
    result.finishedAt = new Date().toISOString();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.success) throw Object.assign(new Error('Execution performance gate failed'), { benchmarkResult: result });
  } catch (error) {
    keep = true;
    const payload = {
      error: error instanceof Error ? error.message : String(error),
      benchmarkRoot: root,
      benchmarkResult: error?.benchmarkResult,
    };
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exitCode = 1;
  } finally {
    await service.close().catch(() => undefined);
    if (!keep) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

await main();
