import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const script = resolve('scripts/prepare-distribution.mjs');

test('distribution preparation omits Google client file when build credentials are absent', async () => {
  const out = await mkdtemp(join(tmpdir(), 'pb-dist-config-empty-'));
  const result = spawnSync(process.execPath, [script], {
    cwd: resolve('.'),
    env: { ...process.env, PB_DISTRIBUTION_CONFIG_ROOT: out, PB_GOOGLE_CLIENT_ID: '', PB_GOOGLE_CLIENT_SECRET: '' },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(access(join(out, 'google-oauth-client.json')));
});

test('distribution preparation creates packaged Desktop OAuth config from build environment without source JSON', async () => {
  const out = await mkdtemp(join(tmpdir(), 'pb-dist-config-'));
  const result = spawnSync(process.execPath, [script], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      PB_DISTRIBUTION_CONFIG_ROOT: out,
      PB_GOOGLE_CLIENT_ID: 'desktop-client-id.apps.googleusercontent.com',
      PB_GOOGLE_CLIENT_SECRET: 'desktop-client-secret'
    },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(await readFile(join(out, 'google-oauth-client.json'), 'utf8')) as { installed?: Record<string, unknown> };
  assert.equal(parsed.installed?.client_id, 'desktop-client-id.apps.googleusercontent.com');
  assert.equal(parsed.installed?.client_secret, 'desktop-client-secret');
  assert.equal(parsed.installed?.auth_uri, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(parsed.installed?.token_uri, 'https://oauth2.googleapis.com/token');
});
