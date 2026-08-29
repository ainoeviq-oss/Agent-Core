import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../../src/config/index.js';
import { PresentationBridgeService } from '../../src/application/service.js';

const fixture = resolve('corpus/generated/12-complex-real-world.pptx');

test('application service runs the shared converter, publishes real progress, and persists history', async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'pb-service-'));
  const config = { ...loadConfig(resolve('.')), runtimeRoot };
  const service = new PresentationBridgeService(config);
  const events: Array<{ jobId: string; percent: number; stage: string }> = [];
  const unsubscribe = service.onProgress((event) => events.push(event));

  const { jobId } = service.startConversion({
    sourcePath: fixture,
    target: 'all',
    googleMode: 'mock',
    keynoteMode: 'mock'
  });
  assert.equal(service.hasActiveJobs(), true);
  const finished = await service.waitForJob(jobId);
  assert.equal(service.hasActiveJobs(), false);
  unsubscribe();

  assert.equal(finished.state, 'completed_with_warnings');
  assert.equal(finished.percent, 100);
  assert.equal(finished.report?.jobId, jobId);
  assert.ok(events.some((event) => event.stage === 'preflight'));
  assert.ok(events.some((event) => event.stage === 'converting_google'));
  assert.ok(events.some((event) => event.stage === 'converting_keynote'));

  const restarted = new PresentationBridgeService(config);
  const history = await restarted.listHistory();
  assert.equal(history[0]?.jobId, jobId);
  assert.equal(history[0]?.state, 'completed_with_warnings');
  assert.equal(history[0]?.sourceFilename, '12-complex-real-world.pptx');
});

test('application service exposes platform doctor data without inventing live availability', async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'pb-doctor-service-'));
  const service = new PresentationBridgeService({ ...loadConfig(resolve('.')), runtimeRoot });
  const doctor = await service.doctor();
  assert.equal(doctor.project, 'Presentation-Bridge');
  assert.equal(typeof doctor.google, 'object');
  assert.equal(typeof doctor.keynote, 'object');
  assert.equal(typeof doctor.sourceRenderer, 'object');
});
