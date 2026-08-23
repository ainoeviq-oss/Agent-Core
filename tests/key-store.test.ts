import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileKeyStore } from '../src/auth/key-store.js';

const tempDirs: string[] = [];

async function makeStore(): Promise<FileKeyStore> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'commander-key-store-'));
  tempDirs.push(dir);
  return new FileKeyStore(dir);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('FileKeyStore', () => {
  it('creates a prefixed key without persisting the raw secret', async () => {
    const store = await makeStore();
    const created = await store.create('integration');

    expect(created.key).toMatch(/^agent_core_live_[A-Za-z0-9_-]+$/);
    expect(created.metadata.name).toBe('integration');

    const persisted = await readFile(store.filePath, 'utf8');
    expect(persisted).not.toContain(created.key);
    expect(persisted).not.toContain(created.key.slice('agent_core_live_'.length));
  });

  it('verifies valid keys and rejects invalid keys', async () => {
    const store = await makeStore();
    const created = await store.create('operator');

    const verified = await store.verify(created.key);
    expect(verified?.id).toBe(created.metadata.id);
    expect(verified?.name).toBe('operator');
    expect(await store.verify('agent_core_live_not-the-key')).toBeNull();
  });

  it('rejects revoked and expired keys', async () => {
    const store = await makeStore();
    const active = await store.create('revoked');
    const expired = await store.create('expired', { expiresAt: new Date(Date.now() - 60_000) });

    expect(await store.revoke(active.metadata.id)).toBe(true);
    expect(await store.verify(active.key)).toBeNull();
    expect(await store.verify(expired.key)).toBeNull();

    const listed = await store.list();
    expect(listed.find((key) => key.id === active.metadata.id)?.revokedAt).toBeTruthy();
  });

  it('rotates a key by revoking the old secret and returning a new valid secret', async () => {
    const store = await makeStore();
    const original = await store.create('rotate-me');
    const replacement = await store.rotate(original.metadata.id);

    expect(replacement.key).not.toBe(original.key);
    expect(replacement.metadata.name).toBe('rotate-me');
    expect(await store.verify(original.key)).toBeNull();
    expect((await store.verify(replacement.key))?.id).toBe(replacement.metadata.id);
  });
});
