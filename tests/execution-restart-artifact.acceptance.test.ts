import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ExecutionService } from '../src/execution/service.js';
import type { ExecutionScope } from '../src/execution/types.js';
import { WorkspacePolicy } from '../src/runtime/workspace.js';
import { nodeShellCommand } from './helpers/platform-command.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('execution declared-artifact durability across service restart', () => {
  it('reopens a planned v2 graph with expectedArtifacts intact and verifies them when the persisted run is started', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-core-execution-restart-artifact-'));
    roots.push(root);
    const work = path.join(root, 'work');
    await mkdir(work, { recursive: true });
    const defaults = loadConfig({}, root).execution;
    const config = {
      ...defaults,
      enabled: true,
      dbPath: path.join(root, 'runtime', 'execution', 'restart-artifact.sqlite'),
      logRoot: path.join(root, 'runtime', 'execution', 'runs'),
    };
    const workspace = new WorkspacePolicy([root]);
    const scope = { principalId: 'principal-restart-artifact', projectId: root } satisfies ExecutionScope;
    const artifactPath = path.join(work, 'durable-artifact.json');
    const expectedArtifacts = [{
      path: artifactPath,
      kind: 'file' as const,
      hash: 'sha256' as const,
      required: true,
    }];

    const first = new ExecutionService(config, workspace);
    await first.open();
    const created = await first.create(scope, {
      objective: 'Persist declared artifact contract before restart',
      continuityTaskId: 'task-restart-artifact',
      originRouteContextId: 'route-restart-artifact',
      nodes: [{
        id: 'A',
        purpose: 'write artifact after service restart',
        command: nodeShellCommand(`
          require('node:fs').writeFileSync(
            ${JSON.stringify(artifactPath)},
            JSON.stringify({ durable: true, source: 'reopened-run' }),
          );
        `),
        cwd: work,
        expectedArtifacts,
      }],
    });
    expect(created.state).toBe('planned');
    expect(created.nodes[0]?.expectedArtifacts).toEqual(expectedArtifacts);
    const runId = created.runId;
    await first.close();

    const second = new ExecutionService(config, workspace);
    await second.open();
    try {
      const reopened = await second.status(scope, runId);
      expect(reopened).not.toBeNull();
      expect(reopened?.state).toBe('planned');
      expect(reopened?.nodes[0]?.expectedArtifacts).toEqual(expectedArtifacts);

      const started = await second.start(scope, runId);
      const finished = started.state === 'completed'
        ? started
        : (await second.wait(
          scope,
          runId,
          started.lastEventSequence,
          { eventTypes: ['run.completed'] },
          5_000,
        )).state;

      expect(finished.state).toBe('completed');
      expect(finished.evidence.verification).toBe('verified');
      expect(finished.evidence.nodes).toEqual([
        expect.objectContaining({
          nodeId: 'A',
          resultVersion: 2,
          processState: 'succeeded',
          evidenceState: 'verified',
          artifacts: [expect.objectContaining({
            path: artifactPath,
            kind: 'file',
            required: true,
            exists: true,
            verification: 'verified',
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          })],
        }),
      ]);
    } finally {
      await second.close();
    }

    const third = new ExecutionService(config, workspace);
    await third.open();
    try {
      const finalRead = await third.status(scope, runId);
      expect(finalRead?.state).toBe('completed');
      expect(finalRead?.nodes[0]?.expectedArtifacts).toEqual(expectedArtifacts);
      expect(finalRead?.evidence.verification).toBe('verified');
      expect(finalRead?.evidence.nodes[0]?.artifacts[0]).toMatchObject({
        path: artifactPath,
        verification: 'verified',
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
    } finally {
      await third.close();
    }
  }, 10_000);
});
