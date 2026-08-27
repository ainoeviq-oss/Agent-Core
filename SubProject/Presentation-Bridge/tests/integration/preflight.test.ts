import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadConfig } from '../../src/config/index.js';
import { analyzePptx } from '../../src/pptx/preflight/analyze.js';

test('transition/timing fixture is detected from OOXML', async () => {
  const config = loadConfig(resolve('.'));
  const manifest = await analyzePptx(resolve('corpus/generated/10-animation-transition.pptx'), config);
  assert.equal(manifest.slideCount, 1);
  assert.equal(manifest.featureCounts.transitions, 1);
  assert.equal(manifest.featureCounts.animations, 1);
});

test('notes and hyperlink fixture is inventoried', async () => {
  const config = loadConfig(resolve('.'));
  const manifest = await analyzePptx(resolve('corpus/generated/09-links-notes.pptx'), config);
  assert.ok(manifest.notesSlides.length >= 1);
  assert.ok(manifest.externalRelationships.length >= 1);
});

test('pptm extension is not silently accepted as pptx', async () => {
  const { copyFile, mkdtemp } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { BridgeError, ErrorCode } = await import('../../src/security/errors.js');
  const dir = await mkdtemp(join(tmpdir(),'pb-pptm-'));
  const target = join(dir,'macro.pptm');
  await copyFile(resolve('corpus/generated/01-basic-text-shapes.pptx'),target);
  await assert.rejects(() => analyzePptx(target,loadConfig(resolve('.'))),(error:unknown)=>error instanceof BridgeError && error.code===ErrorCode.SOURCE_UNSUPPORTED_EXTENSION);
});
