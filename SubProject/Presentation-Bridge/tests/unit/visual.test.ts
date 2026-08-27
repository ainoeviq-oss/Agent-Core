import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { compareImages } from '../../src/fidelity/visual/diff.js';

test('visual diff distinguishes identical and modified images', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-visual-'));
  const a = join(dir, 'a.png'); const b = join(dir, 'b.png'); const c = join(dir, 'c.png'); const diff = join(dir, 'diff.png');
  await sharp({ create:{width:100,height:100,channels:4,background:{r:255,g:255,b:255,alpha:1}} }).png().toFile(a);
  await sharp({ create:{width:100,height:100,channels:4,background:{r:255,g:255,b:255,alpha:1}} }).png().toFile(b);
  const raw = Buffer.alloc(100*100*4,255); for(let y=0;y<30;y++) for(let x=0;x<30;x++){const i=(y*100+x)*4;raw[i]=0;raw[i+1]=0;raw[i+2]=0;}
  await sharp(raw,{raw:{width:100,height:100,channels:4}}).png().toFile(c);
  assert.equal((await compareImages(a,b)).similarity,1);
  const changed = await compareImages(a,c,diff);
  assert.ok(changed.similarity < 1);
  assert.ok(changed.mismatchedPixels > 0);
});
