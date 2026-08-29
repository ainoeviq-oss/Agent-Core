import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

test('desktop process wires encrypted Keynote worker settings through IPC and reapplies them to the service', async () => {
  const main = await readFile(resolve('desktop/main.ts'), 'utf8');
  const preload = await readFile(resolve('desktop/preload.cts'), 'utf8');

  assert.match(main, /safeStorage/);
  assert.match(main, /DesktopSettingsStore/);
  assert.match(main, /settingsStore\.applyToConfig/);
  assert.match(main, /pb:keynote-settings:get/);
  assert.match(main, /pb:keynote-settings:save/);
  assert.match(main, /service\.hasActiveJobs\(\)/);

  assert.match(preload, /getKeynoteWorkerSettings/);
  assert.match(preload, /saveKeynoteWorkerSettings/);
  assert.match(preload, /pb:keynote-settings:get/);
  assert.match(preload, /pb:keynote-settings:save/);
});
