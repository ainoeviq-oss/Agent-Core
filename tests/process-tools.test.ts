import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProcessManager, type ProcessSessionOwner } from '../src/runtime/process-manager.js';
import { WorkspacePolicy } from '../src/runtime/workspace.js';
import { printCommand, sleepCommand } from './helpers/platform-command.js';

const roots: string[] = [];

async function waitForStdout(
  manager: ProcessManager,
  sessionId: string,
  owner: ProcessSessionOwner,
  needle: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = manager.read(sessionId, owner);
    if (snapshot.stdout.includes(needle) || !snapshot.running) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return manager.read(sessionId, owner);
}

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-core-proc-'));
  roots.push(root);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'agent-core-proc-out-'));
  roots.push(outside);
  return { root, outside, manager: new ProcessManager(new WorkspacePolicy([root])) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ProcessManager', () => {
  it('executes a bounded command in an allowed directory', async () => {
    const { root, manager } = await setup();
    const result = await manager.execute(printCommand('hello-commander\n'), { cwd: root, timeoutMs: 5000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello-commander');
    expect(result.timedOut).toBe(false);
  });

  it('rejects blocked commands and outside-root working directories', async () => {
    const { root, outside, manager } = await setup();
    await expect(manager.execute('diskpart', { cwd: root, timeoutMs: 1000 })).rejects.toThrow(/blocked command/i);
    await expect(manager.execute(printCommand('x\n'), { cwd: outside, timeoutMs: 1000 })).rejects.toThrow(/outside allowed roots/i);
  });

  it('times out a long-running one-shot command', async () => {
    const { root, manager } = await setup();
    const result = await manager.execute(sleepCommand(2000), { cwd: root, timeoutMs: 100 });
    expect(result.timedOut).toBe(true);
  });

  it('starts, reads, lists, and stops a background process session', async () => {
    const { root, manager } = await setup();
    const started = await manager.start(sleepCommand(5000, 'session-ready\n'), { cwd: root });
    expect(started.sessionId).toMatch(/^proc_/);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const read = manager.read(started.sessionId);
    expect(read.stdout).toContain('session-ready');
    expect(manager.list().some((item) => item.sessionId === started.sessionId)).toBe(true);

    const stopped = await manager.stop(started.sessionId);
    expect(stopped.stopped).toBe(true);
  });

  it('binds background sessions to principal/project/origin route and hides them from a different owner', async () => {
    const { root, manager } = await setup();
    const ownerA = { principalId: 'principal-a', projectId: root, originRouteContextId: 'route-a' };
    const ownerB = { principalId: 'principal-b', projectId: root, originRouteContextId: 'route-b' };
    const started = await manager.start(sleepCommand(5000, 'owned-ready\n'), {
      cwd: root,
      owner: ownerA,
    });

    const ready = await waitForStdout(manager, started.sessionId, ownerA, 'owned-ready');
    expect(manager.sessionContext(started.sessionId, ownerA)).toEqual(ownerA);
    expect(ready.stdout).toContain('owned-ready');
    expect(manager.list(ownerA).map((item) => item.sessionId)).toContain(started.sessionId);
    expect(manager.list(ownerB).map((item) => item.sessionId)).not.toContain(started.sessionId);
    expect(() => manager.read(started.sessionId, ownerB)).toThrow(/not found/i);
    await expect(manager.stop(started.sessionId, ownerB)).rejects.toThrow(/not found/i);

    expect((await manager.stop(started.sessionId, ownerA)).stopped).toBe(true);
  });
});
