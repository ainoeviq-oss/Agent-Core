import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateExecutionDag, type ValidatedExecutionNode } from '../src/execution/dag.js';
import { ExecutionLogStore } from '../src/execution/log-store.js';
import { ExecutionCommandRunner } from '../src/execution/runner.js';
import { WorkspacePolicy } from '../src/runtime/workspace.js';

const roots: string[] = [];

async function fixture(label: string) {
  const base = process.env.TEMP || process.env.TMP || os.tmpdir();
  const root = await mkdtemp(path.join(base, `agent-core-execution-runner-${label}-`));
  roots.push(root);
  const work = path.join(root, 'work');
  const logRoot = path.join(root, 'runtime', 'execution', 'runs');
  await mkdir(work, { recursive: true });
  const logs = new ExecutionLogStore(logRoot);
  const runner = new ExecutionCommandRunner(logs);
  return { root, work, logRoot, logs, runner, workspace: new WorkspacePolicy([root]) };
}

async function validatedNode(workspace: WorkspacePolicy, cwd: string, command: string): Promise<ValidatedExecutionNode> {
  const graph = await validateExecutionDag([{
    id: 'A',
    purpose: 'Runner fixture',
    command,
    cwd,
    timeoutMs: 10_000,
  }], { workspace });
  return graph.nodeById.get('A')!;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('durable execution log store and command runner', () => {
  it('streams factual stdout/stderr and captures the exact process exit code in the terminal result marker', async () => {
    const f = await fixture('streams');
    const node = await validatedNode(
      f.workspace,
      f.work,
      "Write-Output 'hello-out'; [Console]::Error.WriteLine('hello-err'); exit 7",
    );
    const result = await f.runner.run('run-streams', node, 'attempt-streams', 1);

    expect(result).toMatchObject({
      version: 1,
      runId: 'run-streams',
      nodeId: 'A',
      attemptId: 'attempt-streams',
      attemptNo: 1,
      state: 'failed',
      exitCode: 7,
    });
    const stdout = await f.logs.readLog('run-streams', 'A', 1, 'stdout', 0, 1024);
    const stderr = await f.logs.readLog('run-streams', 'A', 1, 'stderr', 0, 1024);
    expect(stdout.data).toContain('hello-out');
    expect(stderr.data).toContain('hello-err');
    expect(await f.logs.readResult('run-streams', 'A', 1)).toEqual(result);

    const paths = f.logs.paths('run-streams', 'A', 1);
    expect(path.basename(paths.stdoutPath)).toBe('attempt-001.stdout.log');
    expect(path.basename(paths.stderrPath)).toBe('attempt-001.stderr.log');
    expect(path.basename(paths.resultPath)).toBe('attempt-001.result.json');
  });

  it('reads logs by byte offset with a hard max-byte bound and stable continuation offsets', async () => {
    const f = await fixture('offset');
    const node = await validatedNode(f.workspace, f.work, "[Console]::Out.Write('ABCDEFGHIJK')");
    await f.runner.run('run-offset', node, 'attempt-offset', 1);

    const first = await f.logs.readLog('run-offset', 'A', 1, 'stdout', 0, 5);
    expect(first).toMatchObject({ data: 'ABCDE', offset: 0, nextOffset: 5, eof: false });
    expect(first.totalBytes).toBeGreaterThan(5);
    const second = await f.logs.readLog('run-offset', 'A', 1, 'stdout', first.nextOffset, 1024);
    expect(`${first.data}${second.data}`).toBe('ABCDEFGHIJK');
    expect(second.eof).toBe(true);
    expect(second.nextOffset).toBe(second.totalBytes);
  });

  it('writes an atomic result marker whose byte counts and SHA-256 hashes reproduce the durable log files exactly', async () => {
    const f = await fixture('hash');
    const node = await validatedNode(
      f.workspace,
      f.work,
      "[Console]::Out.Write('OUT-123'); [Console]::Error.Write('ERR-456')",
    );
    const result = await f.runner.run('run-hash', node, 'attempt-hash', 1);
    const paths = f.logs.paths('run-hash', 'A', 1);
    const stdoutBytes = await readFile(paths.stdoutPath);
    const stderrBytes = await readFile(paths.stderrPath);

    expect(result.state).toBe('succeeded');
    expect(result.exitCode).toBe(0);
    expect(result.stdoutBytes).toBe(stdoutBytes.length);
    expect(result.stderrBytes).toBe(stderrBytes.length);
    expect(result.stdoutSha256).toBe(createHash('sha256').update(stdoutBytes).digest('hex'));
    expect(result.stderrSha256).toBe(createHash('sha256').update(stderrBytes).digest('hex'));
    expect(JSON.parse(await readFile(paths.resultPath, 'utf8'))).toEqual(result);
    expect((await readdir(path.dirname(paths.resultPath))).some((name) => name.includes('.result.json.tmp-'))).toBe(false);
  });

  it('never interprets a missing terminal result marker as success and writes interrupted only after termination is factual', async () => {
    const f = await fixture('interrupt');
    const node = await validatedNode(
      f.workspace,
      f.work,
      "Write-Output 'started'; Start-Sleep -Seconds 30; Write-Output 'never'",
    );
    const handle = await f.runner.start('run-interrupt', node, 'attempt-interrupt', 1);

    expect(await f.logs.readResult('run-interrupt', 'A', 1)).toBeNull();
    handle.terminate('interrupted');
    const result = await handle.completion;
    expect(result.state).toBe('interrupted');
    expect(result.finishedAt).toBeGreaterThanOrEqual(result.startedAt);
    expect(await f.logs.readResult('run-interrupt', 'A', 1)).toEqual(result);
  });

  it('refuses to overwrite an existing attempt evidence directory', async () => {
    const f = await fixture('immutable');
    const node = await validatedNode(f.workspace, f.work, "Write-Output 'once'");
    await f.runner.run('run-immutable', node, 'attempt-immutable-1', 1);
    await expect(f.runner.run('run-immutable', node, 'attempt-immutable-2', 1)).rejects.toThrow(/exist|attempt/i);
  });
});
