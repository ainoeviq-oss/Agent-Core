import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { auditSourceIsolation } from '../../src/security/isolation.js';

test('isolation doctor audits compiled dist/src when source files are not packaged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pb-packaged-isolation-'));
  await mkdir(join(root, 'dist', 'src'), { recursive: true });
  await writeFile(join(root, 'dist', 'src', 'clean.js'), 'export const product = "Presentation Bridge";\n', 'utf8');
  const result = await auditSourceIsolation(root);
  assert.equal(result.clean, true);
  assert.deepEqual(result.findings, []);
});
