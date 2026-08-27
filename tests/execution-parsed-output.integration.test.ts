import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ExecutionService } from '../src/execution/service.js';
import { ExecutionStore } from '../src/execution/store.js';
import { ExecutionLogStore } from '../src/execution/log-store.js';
import { ExecutionOutputParserService } from '../src/execution/output-parser.js';
import { RuntimeMetricRegistry } from '../src/runtime/metric-window.js';
import { WorkspacePolicy } from '../src/runtime/workspace.js';
import { nodeShellCommand } from './helpers/platform-command.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(label: string, outputParserOverride?: any) {
  const root = await mkdtemp(path.join(os.tmpdir(), `agent-core-parsed-output-${label}-`));
  roots.push(root);
  const base = loadConfig({}, root).execution;
  const config = {
    ...base,
    enabled: true,
    dbPath: path.join(root, 'runtime', 'execution.sqlite'),
    logRoot: path.join(root, 'runtime', 'runs'),
  };
  const workspace = new WorkspacePolicy([root]);
  const metrics = new RuntimeMetricRegistry();
  const store = new ExecutionStore();
  const parser = outputParserOverride ?? new ExecutionOutputParserService(store, new ExecutionLogStore(config.logRoot), metrics);
  const service = new ExecutionService(config, workspace, { store, outputParser: parser, metrics });
  await service.open();
  return { root, config, workspace, metrics, service, scope: { principalId: 'parsed-principal', projectId: root } };
}

describe('persisted structured execution output', () => {
  it('persists bounded parsed evidence before terminal wake, exposes it in status, and survives restart', async () => {
    const f = await fixture('persist');
    const secret = 'SENTINEL_PARSED_OUTPUT_SECRET_123456';
    const created = await f.service.create(f.scope, {
      objective: 'parse test output',
      nodes: [{
        id: 'A', purpose: 'emit deterministic test summary',
        command: nodeShellCommand(`
          process.stdout.write('Test Files  1 passed (1)\\nTests  7 passed | 2 skipped (9)\\n');
          process.stderr.write('error: token=${secret} fixture failure sample\\n');
        `),
        cwd: f.root,
      }],
    });
    await f.service.start(f.scope, created.runId);
    const done = await f.service.wait(f.scope, created.runId, created.lastEventSequence, { eventTypes: ['run.completed'] }, 5_000);
    expect(done.event?.eventType).toBe('run.completed');
    const nodeEvidence = done.state.evidence.nodes[0] as any;
    expect(nodeEvidence.parsedOutput).toMatchObject({
      available: true,
      parserVersion: '1.0.0',
      confidence: 0.95,
      structured: {
        testResults: { passed: 7, failed: 0, skipped: 2 },
        errorPatterns: [expect.objectContaining({ type: 'generic', count: 1 })],
      },
    });
    expect(JSON.stringify(done.state)).not.toContain(secret);
    expect(f.metrics.metric('execution.output_parse.duration_ms').count).toBe(1);
    const runId = created.runId;
    await f.service.close();

    const reopenedStore = new ExecutionStore();
    const reopenedMetrics = new RuntimeMetricRegistry();
    const reopened = new ExecutionService(f.config, f.workspace, {
      store: reopenedStore,
      outputParser: new ExecutionOutputParserService(reopenedStore, new ExecutionLogStore(f.config.logRoot), reopenedMetrics),
      metrics: reopenedMetrics,
    });
    await reopened.open();
    try {
      const status = await reopened.status(f.scope, runId);
      expect((status?.evidence.nodes[0] as any)?.parsedOutput).toEqual(nodeEvidence.parsedOutput);
      expect(JSON.stringify(status)).not.toContain(secret);
    } finally {
      await reopened.close();
    }
  }, 10_000);

  it('fails open when the parser observer throws and preserves factual process success', async () => {
    const f = await fixture('fail-open', { parseAttempt: async () => { throw new Error('synthetic parser failure'); } });
    try {
      const created = await f.service.create(f.scope, {
        objective: 'parser failure cannot block process truth',
        nodes: [{ id: 'A', purpose: 'A', command: nodeShellCommand(`process.stdout.write('ok')`), cwd: f.root }],
      });
      await f.service.start(f.scope, created.runId);
      const done = await f.service.wait(f.scope, created.runId, created.lastEventSequence, { eventTypes: ['run.completed'] }, 5_000);
      expect(done.state.state).toBe('completed');
      expect(done.state.evidence.nodes[0]).toMatchObject({ processState: 'succeeded', evidenceState: 'not_declared' });
      expect((done.state.evidence.nodes[0] as any).parsedOutput).toMatchObject({ available: false, status: 'degraded' });
    } finally {
      await f.service.close();
    }
  }, 10_000);
});
