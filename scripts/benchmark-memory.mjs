import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadConfig } from '../dist/config.js';
import { MemoryLifecycle } from '../dist/memory/lifecycle.js';
import { MemoryPreflightEngine } from '../dist/memory/preflight.js';
import { runPersonalizedPageRank } from '../dist/memory/ppr.js';
import { MemoryRetriever } from '../dist/memory/retriever.js';
import { MEMORY_FTS_REBUILD_SQL } from '../dist/memory/schema.js';
import { MemoryStore } from '../dist/memory/store.js';
import { MemoryWorkerClient } from '../dist/memory/worker-client.js';

const DEFAULT_COUNTS = [10_000, 100_000];
const DEFAULT_SAMPLES = 25;
const DEFAULT_WARMUP = 5;
const DEFAULT_TARGET_P95_MS = 150;
const PRINCIPAL_ID = 'benchmark-principal';
const PROJECT_ID = 'benchmark-project';
const HUB_MEMORY_ID = 'mem-000000000';
const FTS_TERM = 'needlebenchmark';

function parseArgs(argv) {
  const result = {
    counts: DEFAULT_COUNTS,
    samples: DEFAULT_SAMPLES,
    warmup: DEFAULT_WARMUP,
    targetP95Ms: DEFAULT_TARGET_P95_MS,
    keep: false,
  };
  for (const arg of argv) {
    if (arg.startsWith('--counts=')) {
      result.counts = arg.slice('--counts='.length).split(',').map(Number).filter((value) => Number.isInteger(value) && value > 0);
    } else if (arg.startsWith('--count=')) {
      const value = Number(arg.slice('--count='.length));
      result.counts = Number.isInteger(value) && value > 0 ? [value] : [];
    } else if (arg.startsWith('--samples=')) {
      result.samples = Number(arg.slice('--samples='.length));
    } else if (arg.startsWith('--warmup=')) {
      result.warmup = Number(arg.slice('--warmup='.length));
    } else if (arg.startsWith('--target-p95-ms=')) {
      result.targetP95Ms = Number(arg.slice('--target-p95-ms='.length));
    } else if (arg === '--keep') {
      result.keep = true;
    }
  }
  if (result.counts.length === 0) throw new Error('At least one positive benchmark count is required');
  if (!Number.isInteger(result.samples) || result.samples < 3 || result.samples > 200) throw new Error('--samples must be 3..200');
  if (!Number.isInteger(result.warmup) || result.warmup < 0 || result.warmup > 50) throw new Error('--warmup must be 0..50');
  if (!(result.targetP95Ms > 0 && Number.isFinite(result.targetP95Ms))) throw new Error('--target-p95-ms must be positive');
  return result;
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(ordered.length - 1, Math.ceil(fraction * ordered.length) - 1));
  return ordered[index];
}

function summarize(values) {
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    samples: values.length,
    minMs: Number(Math.min(...values).toFixed(3)),
    meanMs: Number((total / Math.max(1, values.length)).toFixed(3)),
    p50Ms: Number(percentile(values, 0.50).toFixed(3)),
    p95Ms: Number(percentile(values, 0.95).toFixed(3)),
    maxMs: Number(Math.max(...values).toFixed(3)),
  };
}

async function timeSamples(operation, samples, warmup) {
  for (let index = 0; index < warmup; index += 1) await operation(index, true);
  const timings = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    await operation(index, false);
    timings.push(performance.now() - started);
  }
  return summarize(timings);
}

async function bytes(target) {
  try { return (await stat(target)).size; } catch { return 0; }
}

function memoryId(index) {
  return `mem-${String(index).padStart(9, '0')}`;
}

function revisionId(index) {
  return `rev-${String(index).padStart(9, '0')}`;
}

function eventId(index) {
  return `evt-${String(index).padStart(9, '0')}`;
}

function valueHash(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function syntheticValue(index) {
  if (index === 0) return 'Synthetic root node for exact benchmark hot query.';
  const marker = index % 40 === 0 ? ` ${FTS_TERM}` : '';
  return `Synthetic memory item ${index} category ${index % 1000}${marker}.`;
}

async function seedMemories(client, count) {
  const started = performance.now();
  const baseTime = 2_000_000_000_000;
  const batchSize = 200;
  for (let offset = 0; offset < count; offset += batchSize) {
    const operations = [];
    const end = Math.min(count, offset + batchSize);
    for (let index = offset; index < end; index += 1) {
      const id = memoryId(index);
      const revision = revisionId(index);
      const event = eventId(index);
      const canonicalKey = index === 0 ? 'benchmark.hot' : `synthetic.item.${index}`;
      const value = syntheticValue(index);
      const createdAt = baseTime + index;
      operations.push({
        kind: 'run',
        sql: `INSERT INTO memory_events(
          id, principal_id, project_id, thread_id, resource_id, event_type, source_type, source_ref,
          raw_text, redacted_text, metadata_json, created_at
        ) VALUES (?, ?, ?, NULL, NULL, 'benchmark.seed', 'benchmark', NULL, NULL, ?, '{}', ?)`,
        params: [event, PRINCIPAL_ID, PROJECT_ID, value, createdAt],
      });
      operations.push({
        kind: 'run',
        sql: `INSERT INTO memory_items(
          id, principal_id, project_id, canonical_key, kind, state, importance, pinned, enforcement,
          current_revision_id, created_at, updated_at, last_accessed_at, access_count
        ) VALUES (?, ?, ?, ?, 'observation', 'active', 0.5, 0, 'none', ?, ?, ?, ?, 0)`,
        params: [id, PRINCIPAL_ID, PROJECT_ID, canonicalKey, revision, createdAt, createdAt, createdAt],
      });
      operations.push({
        kind: 'run',
        sql: `INSERT INTO memory_revisions(
          id, memory_id, revision_no, value_text, value_json, value_hash, source_event_id,
          valid_from, valid_to, supersedes_revision_id, created_at
        ) VALUES (?, ?, 1, ?, NULL, ?, ?, ?, NULL, NULL, ?)`,
        params: [revision, id, value, valueHash(value), event, createdAt, createdAt],
      });
      operations.push({
        kind: 'run',
        sql: `INSERT INTO memory_anchors(memory_id, anchor, anchor_type, created_at)
              VALUES (?, ?, 'canonical_key', ?)`,
        params: [id, canonicalKey, createdAt],
      });
    }
    await client.transaction(operations);
  }
  return performance.now() - started;
}

async function seedGraph(client, count) {
  const spokes = Math.min(1500, Math.max(0, count - 1));
  const started = performance.now();
  const operations = [];
  const flush = async () => {
    if (operations.length === 0) return;
    await client.transaction(operations.splice(0));
  };
  for (let index = 1; index <= spokes; index += 1) {
    const id = memoryId(index);
    const createdAt = 2_100_000_000_000 + index;
    operations.push({
      kind: 'run',
      sql: `INSERT OR IGNORE INTO memory_edges(
        from_memory_id, to_memory_id, relation, weight, evidence_event_id, created_at
      ) VALUES (?, ?, 'explicit_relation', 1.0, NULL, ?)`,
      params: [HUB_MEMORY_ID, id, createdAt],
    });
    operations.push({
      kind: 'run',
      sql: `INSERT OR IGNORE INTO memory_edges(
        from_memory_id, to_memory_id, relation, weight, evidence_event_id, created_at
      ) VALUES (?, ?, 'explicit_relation', 1.0, NULL, ?)`,
      params: [id, HUB_MEMORY_ID, createdAt],
    });
    if (operations.length >= 900) await flush();
  }
  await flush();
  return { spokes, elapsedMs: performance.now() - started };
}

async function benchmarkCount(count, options) {
  const root = await mkdtemp(path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), `agent-core-memory-bench-${count}-`));
  const dbPath = path.join(root, 'memory.sqlite');
  const config = {
    ...loadConfig({}, root).memory,
    enabled: true,
    dbPath,
  };
  const scope = { principalId: PRINCIPAL_ID, projectId: PROJECT_ID };
  const client = new MemoryWorkerClient({ maxResponseBytes: 8 * 1024 * 1024 });
  const store = new MemoryStore(client);
  let keepRoot = options.keep;

  try {
    await store.open({ dbPath, busyTimeoutMs: config.busyTimeoutMs });
    const bulkSeedMs = await seedMemories(client, count);
    const graphSeed = await seedGraph(client, count);
    await client.checkpoint();
    const dbBytesBeforeFts = await bytes(dbPath);

    const ftsBuildStarted = performance.now();
    await client.exec(MEMORY_FTS_REBUILD_SQL);
    await client.checkpoint();
    const ftsBuildMs = performance.now() - ftsBuildStarted;
    const dbBytesAfterFts = await bytes(dbPath);
    const ftsOverheadBytes = Math.max(0, dbBytesAfterFts - dbBytesBeforeFts);

    const productionCommitStarted = performance.now();
    const productionCommit = await store.commitMemory({
      scope,
      canonicalKey: `benchmark.production.commit.${count}`,
      kind: 'fact',
      value: `Production commit marker after ${count} active synthetic memories.`,
      sourceType: 'benchmark',
    });
    const productionCommitMs = performance.now() - productionCommitStarted;

    const retriever = new MemoryRetriever(client, config);
    const lifecycle = new MemoryLifecycle(client, config);
    const preflight = new MemoryPreflightEngine(client, retriever, lifecycle);

    const ftsSql = `SELECT memory_id, bm25(memory_fts) AS score
      FROM memory_fts
      WHERE memory_fts MATCH ? AND principal_id = ? AND project_id = ? AND state = 'active'
      ORDER BY score ASC, memory_id COLLATE BINARY ASC
      LIMIT ?`;
    let lastFtsRows = [];
    const ftsCandidate = await timeSamples(async () => {
      lastFtsRows = await client.query(ftsSql, [FTS_TERM, PRINCIPAL_ID, PROJECT_ID, config.seedCap]);
    }, options.samples, options.warmup);

    let lastGraph = null;
    const graphExpansion = await timeSamples(async () => {
      lastGraph = await retriever.expandGraph({ scope, query: 'benchmark.hot' }, [HUB_MEMORY_ID]);
    }, options.samples, options.warmup);
    if (!lastGraph) throw new Error('Graph expansion did not produce a result');

    const validNodes = [...lastGraph.nodeIds].sort((a, b) => a.localeCompare(b));
    const validNodeSet = new Set(validNodes);
    const validEdges = lastGraph.edges.filter((edge) => validNodeSet.has(edge.from) && validNodeSet.has(edge.to));
    const personalization = new Map([[HUB_MEMORY_ID, 1]]);
    const ppr = await timeSamples(async () => {
      runPersonalizedPageRank({
        nodes: validNodes,
        edges: validEdges,
        personalization,
        damping: config.pprDamping,
        epsilon: config.pprEpsilon,
        maxIterations: config.pprMaxIterations,
        maxNodes: config.graphNodeCap,
        maxEdges: config.graphEdgeCap,
      });
    }, options.samples, options.warmup);

    let lastPreflight = null;
    const preflightTiming = await timeSamples(async (index, warmup) => {
      lastPreflight = await preflight.run({
        scope,
        routeContextId: randomUUID(),
        task: 'benchmark.hot',
        context: warmup ? 'warmup' : undefined,
        expiresAt: Date.now() + 5 * 60_000 + index,
      });
    }, options.samples, options.warmup);

    const [counts] = await client.query(`SELECT
      (SELECT count(*) FROM memory_items WHERE principal_id = ? AND project_id = ? AND state = 'active') AS active_items,
      (SELECT count(*) FROM memory_fts WHERE principal_id = ? AND project_id = ?) AS fts_rows,
      (SELECT count(*) FROM memory_edges) AS edge_rows`,
      [PRINCIPAL_ID, PROJECT_ID, PRINCIPAL_ID, PROJECT_ID]);
    const integrity = await client.integrity();

    const result = {
      count,
      activeItems: Number(counts?.active_items ?? 0),
      ftsRows: Number(counts?.fts_rows ?? 0),
      edgeRows: Number(counts?.edge_rows ?? 0),
      dbBytes: dbBytesAfterFts,
      dbBytesBeforeFts,
      ftsOverheadBytes,
      ftsOverheadRatio: Number((ftsOverheadBytes / Math.max(1, dbBytesBeforeFts)).toFixed(4)),
      integrity: integrity.result,
      ingest: {
        bulkSeedMs: Number(bulkSeedMs.toFixed(3)),
        bulkItemsPerSecond: Number((count / Math.max(0.001, bulkSeedMs / 1000)).toFixed(1)),
        graphSeedMs: Number(graphSeed.elapsedMs.toFixed(3)),
        ftsBuildMs: Number(ftsBuildMs.toFixed(3)),
        productionCommitAtScaleMs: Number(productionCommitMs.toFixed(3)),
        productionCommitMemoryId: productionCommit.memoryId,
      },
      ftsCandidate,
      ftsCandidateRows: lastFtsRows.length,
      graphExpansion,
      graph: {
        nodes: lastGraph.nodeIds.size,
        edges: lastGraph.edges.length,
        validEdges: validEdges.length,
        truncated: lastGraph.truncated,
        configuredNodeCap: config.graphNodeCap,
        configuredEdgeCap: config.graphEdgeCap,
      },
      ppr,
      preflight: preflightTiming,
      preflightHits: lastPreflight?.recalled?.length ?? 0,
      targetP95Ms: options.targetP95Ms,
      targetPassed: count < 100_000 || preflightTiming.p95Ms < options.targetP95Ms,
      root: options.keep ? root : undefined,
    };

    if (result.graph.nodes > config.graphNodeCap || result.graph.edges > config.graphEdgeCap) {
      throw new Error(`Graph caps exceeded: ${JSON.stringify(result.graph)}`);
    }
    if (count >= 100_000 && !result.targetPassed) {
      const error = new Error(`100k preflight p95 ${preflightTiming.p95Ms} ms exceeds target ${options.targetP95Ms} ms`);
      error.benchmarkResult = result;
      throw error;
    }
    return result;
  } catch (error) {
    keepRoot = true;
    if (error && typeof error === 'object' && !('benchmarkRoot' in error)) error.benchmarkRoot = root;
    throw error;
  } finally {
    await store.close().catch(() => undefined);
    if (!keepRoot) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const results = [];
  for (const count of options.counts) {
    process.stderr.write(`[memory-benchmark] seeding ${count.toLocaleString('en-US')} active memories\n`);
    const result = await benchmarkCount(count, options);
    results.push(result);
    process.stderr.write(`[memory-benchmark] ${count.toLocaleString('en-US')} p95 preflight=${result.preflight.p95Ms}ms db=${result.dbBytes} bytes\n`);
  }
  const hundredK = results.find((result) => result.count === 100_000);
  const projectionForOneMillion = hundredK ? {
    projectedBulkSeedMs: Number((hundredK.ingest.bulkSeedMs * 10).toFixed(0)),
    projectedDbBytes: hundredK.dbBytes * 10,
    note: 'Linear projection only; run --count=1000000 for an actual measurement when the local time/disk envelope permits.',
  } : undefined;
  const report = {
    benchmark: 'agent-core-deterministic-memory',
    startedAt,
    finishedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    options,
    results,
    projectionForOneMillion,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  const payload = {
    error: error instanceof Error ? error.message : String(error),
    benchmarkRoot: error?.benchmarkRoot,
    benchmarkResult: error?.benchmarkResult,
  };
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = 1;
});
