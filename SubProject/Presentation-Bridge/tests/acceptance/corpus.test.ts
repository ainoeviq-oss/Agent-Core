import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { analyzePptx } from '../../src/pptx/preflight/analyze.js';
import { loadConfig } from '../../src/config/index.js';

test('all 12 controlled corpus PPTX files pass secure preflight', async () => {
  const dir = resolve('corpus/generated');
  const files = (await readdir(dir)).filter((name)=>name.endsWith('.pptx')).sort();
  assert.equal(files.length,12);
  for (const file of files) {
    const manifest = await analyzePptx(join(dir,file), loadConfig(resolve('.')));
    assert.ok(manifest.slideCount >= 1, file);
    assert.equal(manifest.source.filename,file);
  }
});
