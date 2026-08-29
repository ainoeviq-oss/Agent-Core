import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../../src/config/index.js';
import { runConversionJob } from '../../src/jobs/orchestrator.js';
import type { ConversionProgressEvent } from '../../src/types/contracts.js';

const fixture = resolve('corpus/generated/12-complex-real-world.pptx');

test('conversion emits monotonic real stage progress and reaches 100 only after completion', async () => {
  const out = await mkdtemp(join(tmpdir(), 'pb-progress-'));
  const events: ConversionProgressEvent[] = [];
  const result = await runConversionJob(fixture, loadConfig(resolve('.')), {
    jobId: 'progress-contract',
    target: 'all',
    outputRoot: out,
    googleMode: 'mock',
    keynoteMode: 'mock',
    onProgress: (event) => events.push(event)
  });

  assert.equal(result.report.status, 'completed_with_warnings');
  assert.ok(events.length >= 6);
  assert.equal(events[0]?.stage, 'queued');
  assert.equal(events.at(-1)?.stage, 'completed_with_warnings');
  assert.equal(events.at(-1)?.percent, 100);
  for (let index = 1; index < events.length; index += 1) {
    assert.ok((events[index]?.percent ?? -1) >= (events[index - 1]?.percent ?? -1));
  }
  assert.equal(events.slice(0, -1).some((event) => event.percent === 100), false);
});

test('pre-aborted conversion records cancelled state and performs no target conversion', async () => {
  const out = await mkdtemp(join(tmpdir(), 'pb-cancel-'));
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    runConversionJob(fixture, loadConfig(resolve('.')), {
      jobId: 'cancel-contract',
      target: 'all',
      outputRoot: out,
      googleMode: 'mock',
      keynoteMode: 'mock',
      signal: controller.signal
    }),
    /cancelled/i
  );

  const state = JSON.parse(await readFile(join(out, 'cancel-contract', 'job.json'), 'utf8')) as {
    state: string;
    history: Array<{ state: string }>;
  };
  assert.equal(state.state, 'cancelled');
  assert.equal(state.history.at(-1)?.state, 'cancelled');
});
