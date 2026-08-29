import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

test('desktop and hosted surfaces use one simple conversion screen instead of page navigation', async () => {
  const app = await readFile(resolve('ui/src/App.tsx'), 'utf8');

  assert.doesNotMatch(app, /type View =/);
  assert.doesNotMatch(app, /className="sidebar"/);
  assert.doesNotMatch(app, /className="nav-list"/);
  assert.match(app, /<h1>Convert PowerPoint<\/h1>/);
  assert.match(app, />Recent jobs</);
  assert.match(app, />Setup</);
  assert.match(app, /value: 'google'/);
  assert.match(app, /value: 'keynote'/);
  assert.match(app, /value: 'all'/);
  assert.match(app, /data-target=\{option\.value\}/);
  assert.match(app, /'Convert presentation'/);
});

test('simple layout styles keep the converter centered and responsive without sidebar chrome', async () => {
  const styles = await readFile(resolve('ui/src/styles.css'), 'utf8');

  assert.doesNotMatch(styles, /\.sidebar\s*\{/);
  assert.doesNotMatch(styles, /\.nav-list\s*\{/);
  assert.match(styles, /\.converter-shell\s*\{/);
  assert.match(styles, /\.target-grid\s*\{/);
  assert.match(styles, /\.dialog-backdrop\s*\{/);
  assert.match(styles, /@media \(max-width: 720px\)/);
});

test('simple setup dialog can read and save encrypted Keynote worker settings through the UI bridge', async () => {
  const app = await readFile(resolve('ui/src/App.tsx'), 'utf8');
  const uiBridge = await readFile(resolve('ui/src/bridge.ts'), 'utf8');

  assert.match(app, /bridge\.getKeynoteWorkerSettings\(\)/);
  assert.match(app, /bridge\.saveKeynoteWorkerSettings\(input\)/);
  assert.match(uiBridge, /getKeynoteWorkerSettings\(\):/);
  assert.match(uiBridge, /saveKeynoteWorkerSettings\(input:/);
  assert.match(uiBridge, /api\.getKeynoteWorkerSettings\(\)/);
  assert.match(uiBridge, /api\.saveKeynoteWorkerSettings\(input\)/);
});

test('renderer entry point declares a restrictive content security policy', async () => {
  const html = await readFile(resolve('ui/index.html'), 'utf8');

  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src 'self'/);
  assert.match(html, /script-src 'self'/);
  assert.match(html, /object-src 'none'/);
});
