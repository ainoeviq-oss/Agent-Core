import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ExecutionArtifactManager } from '../src/execution/artifact-manager.js';
import { ExecutionService } from '../src/execution/service.js';
import { ExecutionLogStore } from '../src/execution/log-store.js';
import { ExecutionStore } from '../src/execution/store.js';
import { WorkspacePolicy } from '../src/runtime/workspace.js';
import { nodeShellCommand } from './helpers/platform-command.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(label: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), `agent-core-artifact-manager-${label}-`));
  roots.push(root);
  const config = {
    ...loadConfig({}, root).execution,
    enabled: true,
    dbPath: path.join(root, 'runtime', 'execution.sqlite'),
    logRoot: path.join(root, 'runtime', 'runs'),
  };
  const workspace = new WorkspacePolicy([root]);
  const store = new ExecutionStore();
  const artifacts = new ExecutionArtifactManager(store, workspace, new ExecutionLogStore(config.logRoot));
  const service = new ExecutionService(config, workspace, { store, artifactManager: artifacts });
  await service.open();
  return { root, config, workspace, store, artifacts, service, scope: { principalId: 'artifact-principal', projectId: root } };
}

async function runArtifact(f: Awaited<ReturnType<typeof fixture>>, name: string, contents: string) {
  const target = path.join(f.root, name);
  const created = await f.service.create(f.scope, {
    objective: `create ${name}`,
    nodes: [{
      id: 'A', purpose: `write ${name}`,
      command: nodeShellCommand(`require('node:fs').writeFileSync(${JSON.stringify(target)}, ${JSON.stringify(contents)})`),
      cwd: f.root,
      expectedArtifacts: [{ path: target, kind: 'file', hash: 'sha256', required: true, artifactType: 'build' }],
    }],
  });
  await f.service.start(f.scope, created.runId);
  const done = await f.service.wait(f.scope, created.runId, created.lastEventSequence, { eventTypes: ['run.completed'] }, 5_000);
  return { target, runId: created.runId, state: done.state };
}

describe('verified execution artifact manager', () => {
  it('indexes verified artifacts exactly once, supports scoped hash/type lookup, and persists across restart', async () => {
    const f = await fixture('index');
    const first = await runArtifact(f, 'bundle-a.bin', 'same-bytes');
    const evidence = first.state.evidence.nodes[0].artifacts[0] as any;
    const byType = await f.artifacts.findByType(f.scope, 'build');
    expect(byType).toHaveLength(1);
    expect(byType[0]).toMatchObject({ runId: first.runId, nodeId: 'A', path: first.target, artifactType: 'build', sha256: evidence.sha256, verification: 'verified' });
    await f.artifacts.indexAttempt(f.scope, first.runId, 'A', 1);
    expect(await f.artifacts.findByType(f.scope, 'build')).toHaveLength(1);

    const second = await runArtifact(f, 'bundle-b.bin', 'same-bytes');
    expect(second.state.nodes[0].attemptCount).toBe(1); // cache awareness never skips execution
    const byHash = await f.artifacts.findByHash(f.scope, evidence.sha256);
    expect(byHash.map((item) => item.runId).sort()).toEqual([first.runId, second.runId].sort());

    await f.service.close();
    const reopenedStore = new ExecutionStore();
    await reopenedStore.open({ dbPath: f.config.dbPath });
    try {
      const reopened = new ExecutionArtifactManager(reopenedStore, f.workspace, new ExecutionLogStore(f.config.logRoot));
      expect(await reopened.findByHash(f.scope, evidence.sha256)).toHaveLength(2);
    } finally { await reopenedStore.close(); }
  }, 10_000);

  it('never indexes missing/unverified artifacts as reusable and invalidates stale files', async () => {
    const f = await fixture('stale');
    try {
      const missingPath = path.join(f.root, 'missing.bin');
      const missing = await f.service.create(f.scope, {
        objective: 'missing artifact must never enter cache index',
        nodes: [{
          id: 'M', purpose: 'declare but do not create artifact', command: nodeShellCommand(`process.stdout.write('no artifact')`), cwd: f.root,
          expectedArtifacts: [{ path: missingPath, kind: 'file', hash: 'sha256', required: true, artifactType: 'build' }],
        }],
      });
      await f.service.start(f.scope, missing.runId);
      const failed = await f.service.wait(f.scope, missing.runId, missing.lastEventSequence, { eventTypes: ['run.failed'] }, 5_000);
      expect(failed.state.evidence.verification).toBe('failed');
      expect(await f.artifacts.findByRun(f.scope, missing.runId)).toEqual([]);

      const first = await runArtifact(f, 'stale.bin', 'cacheable');
      const hash = (first.state.evidence.nodes[0].artifacts[0] as any).sha256;
      expect((await f.artifacts.findReusable(f.scope, { sha256: hash, excludeRunId: 'other-run' })).found).toBe(true);
      await unlink(first.target);
      const stale = await f.artifacts.findReusable(f.scope, { sha256: hash, excludeRunId: 'other-run' });
      expect(stale).toMatchObject({ found: false, advisoryOnly: true });
    } finally { await f.service.close(); }
  }, 10_000);

  it('reconciles a missed verified artifact index from durable terminal evidence after service restart', async () => {
    const f = await fixture('reconcile');
    const originalIndex = f.service.artifacts.indexAttempt.bind(f.service.artifacts);
    f.service.artifacts.indexAttempt = (async () => { throw new Error('synthetic indexing interruption'); }) as typeof f.service.artifacts.indexAttempt;
    const first = await runArtifact(f, 'reconcile.bin', 'durable-evidence');
    const hash = (first.state.evidence.nodes[0].artifacts[0] as any).sha256;
    expect(await f.artifacts.findByHash(f.scope, hash)).toEqual([]);
    f.service.artifacts.indexAttempt = originalIndex;
    await f.service.close();

    const reopenedStore = new ExecutionStore();
    const reopened = new ExecutionService(f.config, f.workspace, { store: reopenedStore });
    await reopened.open();
    try {
      const indexed = await reopened.artifacts.findByHash(f.scope, hash);
      expect(indexed).toEqual([expect.objectContaining({ runId: first.runId, nodeId: 'A', path: first.target, sha256: hash })]);
    } finally { await reopened.close(); }
  }, 10_000);

  it('isolates lookup by principal/project and only suggests purge candidates without deleting files', async () => {
    const f = await fixture('scope');
    try {
      const first = await runArtifact(f, 'retained.bin', 'retained');
      const hash = (first.state.evidence.nodes[0].artifacts[0] as any).sha256;
      expect(await f.artifacts.findByHash({ principalId: 'other', projectId: f.root }, hash)).toEqual([]);
      expect(await f.artifacts.findByHash({ principalId: f.scope.principalId, projectId: `${f.root}-other` }, hash)).toEqual([]);
      const suggestions = await f.artifacts.suggestPurge(f.scope, { olderThanMs: 0 });
      expect(suggestions).toEqual([expect.objectContaining({ path: first.target, reason: expect.any(String), safeToReview: true })]);
      expect(await readFile(first.target, 'utf8')).toBe('retained');
    } finally { await f.service.close(); }
  }, 10_000);
});
