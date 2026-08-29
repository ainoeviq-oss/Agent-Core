import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../../src/config/index.js';
import { PresentationBridgeService } from '../../src/application/service.js';
import { startHostedServer } from '../../src/hosted/server.js';

const fixture = resolve('corpus/generated/12-complex-real-world.pptx');

test('hosted transport uploads PPTX into the shared service and exposes truthful job/history state', async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'pb-hosted-'));
  const service = new PresentationBridgeService({ ...loadConfig(resolve('.')), runtimeRoot });
  const hosted = await startHostedServer({ service, host: '127.0.0.1', port: 0, serveUi: false });
  try {
    const body = await readFile(fixture);
    const response = await fetch(`${hosted.baseUrl}/api/jobs?target=all&googleMode=mock&keynoteMode=mock`, {
      method: 'POST',
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'x-pb-filename': 'fixture.pptx',
        'content-length': String(body.length)
      },
      body
    });
    assert.equal(response.status, 202);
    const accepted = await response.json() as { jobId: string };
    assert.ok(accepted.jobId);

    let state = 'queued';
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const statusResponse = await fetch(`${hosted.baseUrl}/api/jobs/${accepted.jobId}`);
      assert.equal(statusResponse.status, 200);
      const snapshot = await statusResponse.json() as { state: string; report?: { status: string } };
      state = snapshot.state;
      if (['completed', 'completed_with_warnings', 'failed', 'cancelled'].includes(state)) {
        assert.equal(snapshot.report?.status, 'completed_with_warnings');
        break;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    assert.equal(state, 'completed_with_warnings');

    const historyResponse = await fetch(`${hosted.baseUrl}/api/history`);
    assert.equal(historyResponse.status, 200);
    const history = await historyResponse.json() as Array<{ jobId: string; sourceFilename?: string }>;
    assert.equal(history[0]?.jobId, accepted.jobId);
    assert.equal(history[0]?.sourceFilename, 'fixture.pptx');
  } finally {
    await hosted.close();
  }
});

test('hosted transport rejects non-PPTX uploads before a job is created', async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'pb-hosted-reject-'));
  const service = new PresentationBridgeService({ ...loadConfig(resolve('.')), runtimeRoot });
  const hosted = await startHostedServer({ service, host: '127.0.0.1', port: 0, serveUi: false });
  try {
    const response = await fetch(`${hosted.baseUrl}/api/jobs?target=google`, {
      method: 'POST',
      headers: { 'x-pb-filename': 'payload.txt', 'content-type': 'text/plain' },
      body: 'not a presentation'
    });
    assert.equal(response.status, 415);
  } finally {
    await hosted.close();
  }
});
