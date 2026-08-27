import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionDagError, readyNodes, validateExecutionDag, type ExecutionNodeSpec } from '../src/execution/dag.js';
import { WorkspacePolicy } from '../src/runtime/workspace.js';

const roots: string[] = [];

async function fixture(label: string) {
  const base = process.env.TEMP || process.env.TMP || os.tmpdir();
  const root = await mkdtemp(path.join(base, `agent-core-execution-dag-${label}-`));
  roots.push(root);
  const work = path.join(root, 'work');
  await mkdir(work, { recursive: true });
  return { root, work, workspace: new WorkspacePolicy([root]) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function expectDagCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toEqual(expect.objectContaining<Partial<ExecutionDagError>>({ code }));
}

function node(id: string, cwd: string, overrides: Partial<ExecutionNodeSpec> = {}): ExecutionNodeSpec {
  return {
    id,
    purpose: `Purpose ${id}`,
    command: `Write-Output '${id}'`,
    cwd,
    ...overrides,
  };
}

describe('deterministic execution DAG validation', () => {
  it('rejects duplicate IDs, missing dependencies, cycles, and graphs above the configured bound', async () => {
    const f = await fixture('shape');
    await expectDagCode(validateExecutionDag([
      node('A', f.work), node('A', f.work),
    ], { workspace: f.workspace }), 'EXECUTION_NODE_DUPLICATE');

    await expectDagCode(validateExecutionDag([
      node('A', f.work, { dependsOn: ['missing'] }),
    ], { workspace: f.workspace }), 'EXECUTION_DEPENDENCY_MISSING');

    await expectDagCode(validateExecutionDag([
      node('A', f.work, { dependsOn: ['B'] }),
      node('B', f.work, { dependsOn: ['A'] }),
    ], { workspace: f.workspace }), 'EXECUTION_DAG_CYCLE');

    const tooMany = Array.from({ length: 129 }, (_, index) => node(`N${String(index).padStart(3, '0')}`, f.work));
    await expectDagCode(validateExecutionDag(tooMany, { workspace: f.workspace, maxNodes: 128 }), 'EXECUTION_NODE_LIMIT');
  });

  it('rejects outside-root CWD and blocked commands before any command is persisted or run', async () => {
    const f = await fixture('safety');
    await expectDagCode(validateExecutionDag([
      node('A', path.dirname(f.root)),
    ], { workspace: f.workspace }), 'EXECUTION_CWD_OUTSIDE_ROOT');

    await expectDagCode(validateExecutionDag([
      node('A', f.work, { command: 'shutdown /s /t 0' }),
    ], { workspace: f.workspace }), 'EXECUTION_COMMAND_BLOCKED');
  });

  it('rejects obvious inline secret literals while allowing environment/file references', async () => {
    const f = await fixture('secret');
    for (const command of [
      'Write-Output api_key=super-secret-literal',
      'Write-Output password:hunter2',
      'Write-Output "Authorization: Bearer abcdefghijklmnopqrstuvwxyz"',
      "$env:CLIENT_SECRET='literal-secret-value'; Write-Output ok",
    ]) {
      await expectDagCode(validateExecutionDag([
        node('A', f.work, { command }),
      ], { workspace: f.workspace }), 'EXECUTION_INLINE_SECRET');
    }

    const allowed = await validateExecutionDag([
      node('A', f.work, { command: 'Write-Output $env:API_KEY' }),
      node('B', f.work, { command: "Get-Content '.\\secrets\\control-plane-api-key.txt'" }),
    ], { workspace: f.workspace });
    expect(allowed.topologicalOrder).toEqual(['A', 'B']);
  });

  it('normalizes node fields and produces a stable topological order with node ID as the final tie-break', async () => {
    const f = await fixture('order');
    const input = [
      node('D', f.work, { dependsOn: ['B', 'A'], timeoutMs: 10_000 }),
      node('B', f.work),
      node('C', f.work, { dependsOn: ['A', 'A'], continueOnFailure: true }),
      node('A', f.work),
    ];
    const first = await validateExecutionDag(input, { workspace: f.workspace });
    const second = await validateExecutionDag([...input].reverse(), { workspace: f.workspace });

    expect(first.topologicalOrder).toEqual(['A', 'B', 'C', 'D']);
    expect(second.topologicalOrder).toEqual(first.topologicalOrder);
    expect(first.nodes.map((item) => item.id)).toEqual(first.topologicalOrder);
    expect(first.nodeById.get('C')).toMatchObject({
      dependsOn: ['A'],
      timeoutMs: 30_000,
      continueOnFailure: true,
    });
    expect(first.nodeById.get('D')).toMatchObject({
      dependsOn: ['A', 'B'],
      timeoutMs: 10_000,
      continueOnFailure: false,
    });
  });

  it('makes independent A/B ready simultaneously and unlocks C after only A succeeds while D waits for A+B', async () => {
    const f = await fixture('ready');
    const graph = await validateExecutionDag([
      node('D', f.work, { dependsOn: ['A', 'B'] }),
      node('C', f.work, { dependsOn: ['A'] }),
      node('B', f.work),
      node('A', f.work),
    ], { workspace: f.workspace });

    expect(readyNodes(graph, {}).map((item) => item.id)).toEqual(['A', 'B']);
    expect(readyNodes(graph, {
      A: 'succeeded', B: 'running', C: 'queued', D: 'queued',
    }).map((item) => item.id)).toEqual(['C']);
    expect(readyNodes(graph, {
      A: 'succeeded', B: 'succeeded', C: 'queued', D: 'queued',
    }).map((item) => item.id)).toEqual(['C', 'D']);
    expect(readyNodes(graph, {
      A: 'failed', B: 'queued', C: 'queued', D: 'queued',
    }).map((item) => item.id)).toEqual(['B']);
  });

  it('normalizes declared artifacts and rejects unsafe or internally inconsistent evidence declarations', async () => {
    const f = await fixture('artifacts');
    const graph = await validateExecutionDag([
      node('A', f.work, {
        expectedArtifacts: [{
          path: path.join('dist', 'result.json'),
          kind: 'file',
          hash: 'sha256',
          required: true,
        }],
      }),
    ], { workspace: f.workspace });
    expect(graph.nodeById.get('A')?.expectedArtifacts).toEqual([{
      path: path.join(f.work, 'dist', 'result.json'),
      kind: 'file',
      hash: 'sha256',
      required: true,
      artifactType: 'other',
    }]);

    await expectDagCode(validateExecutionDag([
      node('A', f.work, {
        expectedArtifacts: [{ path: path.join(path.dirname(f.root), 'escape.txt'), kind: 'file' }],
      }),
    ], { workspace: f.workspace }), 'EXECUTION_ARTIFACT_OUTSIDE_ROOT');

    await expectDagCode(validateExecutionDag([
      node('A', f.work, {
        expectedArtifacts: [{ path: 'dist', kind: 'directory', hash: 'sha256' }],
      }),
    ], { workspace: f.workspace }), 'EXECUTION_ARTIFACT_HASH_INVALID');
  });

  it('rejects malformed node IDs/text/timeouts and invalid configured maxNodes deterministically', async () => {
    const f = await fixture('validation');
    await expectDagCode(validateExecutionDag([
      node('bad id with spaces', f.work),
    ], { workspace: f.workspace }), 'EXECUTION_NODE_ID_INVALID');
    await expectDagCode(validateExecutionDag([
      node('A', f.work, { purpose: '   ' }),
    ], { workspace: f.workspace }), 'EXECUTION_PURPOSE_REQUIRED');
    await expectDagCode(validateExecutionDag([
      node('A', f.work, { command: '   ' }),
    ], { workspace: f.workspace }), 'EXECUTION_COMMAND_REQUIRED');
    await expectDagCode(validateExecutionDag([
      node('A', f.work, { timeoutMs: 0 }),
    ], { workspace: f.workspace }), 'EXECUTION_TIMEOUT_INVALID');
    await expectDagCode(validateExecutionDag([
      node('A', f.work),
    ], { workspace: f.workspace, maxNodes: 0 }), 'EXECUTION_NODE_LIMIT_INVALID');
  });
});
