import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../../src/config/index.js';
import { runConversionJob } from '../../src/jobs/orchestrator.js';

test('end-to-end mock job creates evidence without fake native artifacts', async () => {
  const out = await mkdtemp(join(tmpdir(), 'pb-job-'));
  const result = await runConversionJob(resolve('corpus/generated/12-complex-real-world.pptx'), loadConfig(resolve('.')), { target:'all', outputRoot:out, googleMode:'mock', keynoteMode:'mock' });
  assert.equal(result.report.targets.google?.native, false);
  assert.equal(result.report.targets.keynote?.native, false);
  assert.equal(result.report.targets.google?.verification, 'mock');
  assert.equal(result.report.targets.keynote?.verification, 'mock');
  await access(join(result.jobRoot,'conversion-report.json'));
  await access(join(result.jobRoot,'compatibility-report.html'));
  const keynoteFiles = await readdir(join(result.jobRoot,'keynote'));
  assert.equal(keynoteFiles.some((name)=>name.endsWith('.key')), false);
});
