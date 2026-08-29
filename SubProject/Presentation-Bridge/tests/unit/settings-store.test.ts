import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../../src/config/index.js';
import { DesktopSettingsStore } from '../../src/application/settings-store.js';

const crypto = {
  encrypt: (plain: string) => Buffer.from(`sealed:${plain}`, 'utf8').toString('base64'),
  decrypt: (cipher: string) => Buffer.from(cipher, 'base64').toString('utf8').replace(/^sealed:/, '')
};

test('desktop settings store persists remote worker token encrypted and applies it to runtime config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pb-settings-'));
  const path = join(root, 'settings.json');
  const store = new DesktopSettingsStore(path, crypto);
  const view = await store.saveKeynoteWorker({ mode: 'remote', url: 'https://worker.example.com', token: 'super-secret-worker-token' });
  assert.equal(view.mode, 'remote');
  assert.equal(view.url, 'https://worker.example.com');
  assert.equal(view.tokenConfigured, true);

  const raw = await readFile(path, 'utf8');
  assert.doesNotMatch(raw, /super-secret-worker-token/);
  assert.match(raw, /tokenCiphertext/);

  const applied = await store.applyToConfig(loadConfig(resolve('.')));
  assert.equal(applied.keynoteWorker, 'remote');
  assert.equal(applied.keynoteRemoteUrl, 'https://worker.example.com');
  assert.equal(applied.keynoteRemoteToken, 'super-secret-worker-token');
});

test('desktop settings store can switch back to local worker and rejects insecure remote URL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pb-settings-local-'));
  const store = new DesktopSettingsStore(join(root, 'settings.json'), crypto);
  await assert.rejects(store.saveKeynoteWorker({ mode: 'remote', url: 'http://worker.example.com', token: 'token' }), /HTTPS/i);
  await store.saveKeynoteWorker({ mode: 'remote', url: 'https://worker.example.com', token: 'token' });
  const local = await store.saveKeynoteWorker({ mode: 'local' });
  assert.deepEqual(local, { mode: 'local', url: '', tokenConfigured: false });
  const applied = await store.applyToConfig(loadConfig(resolve('.')));
  assert.equal(applied.keynoteWorker, 'local');
  assert.equal(applied.keynoteRemoteUrl, undefined);
  assert.equal(applied.keynoteRemoteToken, undefined);
});
