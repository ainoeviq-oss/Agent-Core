import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProcessManager } from '../src/runtime/process-manager.js';
import { WorkspacePolicy } from '../src/runtime/workspace.js';

const roots: string[] = [];
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
  it('executes a bounded PowerShell command in an allowed directory', async () => {
    const { root, manager } = await setup();
    const result = await manager.execute("Write-Output 'hello-commander'", { cwd: root, timeoutMs: 5000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello-commander');
    expect(result.timedOut).toBe(false);
  });

  it('rejects blocked commands and outside-root working directories', async () => {
    const { root, outside, manager } = await setup();
    await expect(manager.execute('diskpart', { cwd: root, timeoutMs: 1000 })).rejects.toThrow(/blocked command/i);
    await expect(manager.execute("Write-Output 'x'", { cwd: outside, timeoutMs: 1000 })).rejects.toThrow(/outside allowed roots/i);
  });

  it('times out a long-running one-shot command', async () => {
    const { root, manager } = await setup();
    const result = await manager.execute('Start-Sleep -Seconds 2', { cwd: root, timeoutMs: 100 });
    expect(result.timedOut).toBe(true);
  });

  it('starts, reads, lists, and stops a background process session', async () => {
    const { root, manager } = await setup();
    const started = await manager.start("Write-Output 'session-ready'; Start-Sleep -Seconds 5", { cwd: root });
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
    const started = await manager.start("Write-Output 'owned-ready'; Start-Sleep -Seconds 5", {
      cwd: root,
      owner: ownerA,
    });

    expect(manager.sessionContext(started.sessionId, ownerA)).toEqual(ownerA);
    expect(manager.read(started.sessionId, ownerA).stdout).toContain('owned-ready');
    expect(manager.list(ownerA).map((item) => item.sessionId)).toContain(started.sessionId);
    expect(manager.list(ownerB).map((item) => item.sessionId)).not.toContain(started.sessionId);
    expect(() => manager.read(started.sessionId, ownerB)).toThrow(/not found/i);
    await expect(manager.stop(started.sessionId, ownerB)).rejects.toThrow(/not found/i);

    expect((await manager.stop(started.sessionId, ownerA)).stopped).toBe(true);
  });
});
