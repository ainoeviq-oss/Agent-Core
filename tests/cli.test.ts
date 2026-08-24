import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileKeyStore } from '../src/auth/key-store.js';
import { runCli } from '../src/cli.js';

const roots: string[] = [];

async function cliHarness() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-core-cli-'));
  roots.push(root);
  const dataDir = path.join(root, 'data');
  const stdout: string[] = [];
  const stderr: string[] = [];
  const execute = (args: string[]) => runCli(args, {
    dataDir,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  return { dataDir, stdout, stderr, execute };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Agent Core key CLI', () => {
  it('creates a key and lists only non-secret metadata', async () => {
    const harness = await cliHarness();
    expect(await harness.execute(['create-key', 'chatgpt'])).toBe(0);

    const created = JSON.parse(harness.stdout.at(-1)!) as { key: string; metadata: { id: string } };
    expect(created.key).toMatch(/^agent_core_live_/);

    harness.stdout.length = 0;
    expect(await harness.execute(['list-keys'])).toBe(0);
    const listedText = harness.stdout.join('\n');
    const listed = JSON.parse(listedText) as Array<{ id: string; name: string }>;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: created.metadata.id, name: 'chatgpt' });
    expect(listedText).not.toContain(created.key);
  });

  it('revokes an existing key and reports revoked metadata on list', async () => {
    const harness = await cliHarness();
    await harness.execute(['create-key', 'revoke-cli']);
    const created = JSON.parse(harness.stdout.at(-1)!) as { metadata: { id: string } };

    harness.stdout.length = 0;
    expect(await harness.execute(['revoke-key', created.metadata.id])).toBe(0);
    expect(JSON.parse(harness.stdout.at(-1)!)).toMatchObject({
      id: created.metadata.id,
      revoked: true,
    });

    harness.stdout.length = 0;
    await harness.execute(['list-keys']);
    const listed = JSON.parse(harness.stdout.at(-1)!) as Array<{ revokedAt: string | null }>;
    expect(listed[0]?.revokedAt).toBeTruthy();
  });

  it('rotates through the CLI and invalidates the prior key', async () => {
    const harness = await cliHarness();
    await harness.execute(['create-key', 'rotate-cli']);
    const original = JSON.parse(harness.stdout.at(-1)!) as { key: string; metadata: { id: string } };

    harness.stdout.length = 0;
    expect(await harness.execute(['rotate-key', original.metadata.id])).toBe(0);
    const rotated = JSON.parse(harness.stdout.at(-1)!) as { key: string; metadata: { id: string } };
    expect(rotated.key).toMatch(/^agent_core_live_/);
    expect(rotated.key).not.toBe(original.key);

    const store = new FileKeyStore(harness.dataDir);
    expect(await store.verify(original.key)).toBeNull();
    expect((await store.verify(rotated.key))?.id).toBe(rotated.metadata.id);
  });

  it('returns a nonzero code for incomplete or unknown commands', async () => {
    const harness = await cliHarness();
    expect(await harness.execute(['create-key'])).not.toBe(0);
    expect(await harness.execute(['unknown-command'])).not.toBe(0);
    expect(harness.stderr.join('\n')).toContain('Usage:');
  });
});

describe('Agent Core OAuth reset CLI', () => {
  it('resets grants from the canonical data directory and imports legacy clients', async () => {
    const harness = await cliHarness();
    const { FileOAuthStore } = await import('../src/oauth/store.js');
    const keyStore = new FileKeyStore(harness.dataDir);
    const key = await keyStore.create('custom-local-cli');
    const activeStore = new FileOAuthStore(harness.dataDir);
    const activeClient = await activeStore.registerClient({
      clientName: 'Existing', redirectUris: ['https://chatgpt.com/connector/oauth/existing'],
      grantTypes: ['authorization_code', 'refresh_token'], responseTypes: ['code'],
      tokenEndpointAuthMethod: 'client_secret_post',
    });
    const tokens = await activeStore.issueTokens({
      clientId: activeClient.client_id, resource: 'https://example.test/mcp', scopes: ['mcp:tools'],
      keyId: key.metadata.id, keyName: key.metadata.name,
    });
    const legacyDir = path.join(path.dirname(harness.dataDir), 'data-current');
    const legacyStore = new FileOAuthStore(legacyDir);
    const legacyClient = await legacyStore.registerClient({
      clientName: 'ChatGPT', redirectUris: ['https://chatgpt.com/connector/oauth/QTOb4VcHdCsW'],
      grantTypes: ['authorization_code', 'refresh_token'], responseTypes: ['code'],
      tokenEndpointAuthMethod: 'client_secret_post',
    });

    harness.stdout.length = 0;
    expect(await harness.execute(['reset-oauth', legacyDir])).toBe(0);
    const result = JSON.parse(harness.stdout.at(-1)!);
    expect(result).toMatchObject({ clientsImported: 1, grantsCleared: true });
    expect(await activeStore.getClient(legacyClient.client_id)).not.toBeNull();
    expect(await activeStore.verifyAccessToken(tokens.accessToken)).toBeNull();
    expect((await keyStore.verify(key.key))?.id).toBe(key.metadata.id);
  });
});
