import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

test('keynote worker CLI fails closed when authentication token is missing', () => {
  const env = { ...process.env };
  delete env.PB_KEYNOTE_WORKER_TOKEN;
  const result = spawnSync(process.execPath, [resolve('dist/src/cli/index.js'), 'keynote', 'worker'], {
    cwd: resolve('.'),
    env,
    encoding: 'utf8',
    timeout: 5000
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /authentication token/i);
  assert.doesNotMatch(result.stderr, /PB_KEYNOTE_WORKER_TOKEN=.*[^\s]/i);
});
