import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProcessManager } from '../src/processes.js';

let base: string;
let root: string;
let runtimeDir: string;

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'codespace-process-'));
  root = path.join(base, 'repo');
  runtimeDir = path.join(base, 'runtime');
  await fs.mkdir(root);
  await fs.mkdir(runtimeDir);
});

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

describe('owned process sessions', () => {
  it('lists only manager-owned sessions and stop is idempotent', async () => {
    const manager = new ProcessManager(root, runtimeDir, base);
    const started = await manager.start({ command: 'sleep 30' });
    expect(manager.list().map((item) => item.sessionId)).toContain(started.sessionId);
    await manager.stop(started.sessionId);
    await expect(manager.stop(started.sessionId)).resolves.toMatchObject({
      sessionId: started.sessionId,
    });
  });

  it('rejects unknown session ids', async () => {
    const manager = new ProcessManager(root, runtimeDir, base);
    await expect(manager.stop('missing-session')).rejects.toMatchObject({
      code: 'UNKNOWN_PROCESS_SESSION',
    });
  });
});
