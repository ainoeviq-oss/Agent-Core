import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../../src/config/index.js';
import { PresentationBridgeService } from '../../src/application/service.js';

test('application service publishes a terminal failed event when orchestration throws before target completion', async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'pb-service-failure-'));
  const service = new PresentationBridgeService({ ...loadConfig(resolve('.')), runtimeRoot });
  const stages: string[] = [];
  service.onProgress((event) => stages.push(event.stage));
  const { jobId } = service.startConversion({ sourcePath: join(runtimeRoot, 'missing.pptx'), target: 'google', googleMode: 'mock' });
  const snapshot = await service.waitForJob(jobId);
  assert.equal(snapshot.state, 'failed');
  assert.equal(stages.at(-1), 'failed');
});
