import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { startRemoteKeynoteWorkerServer } from '../../src/workers/keynote/remote-server.js';
import type { TargetResult } from '../../src/types/contracts.js';

const fixture = resolve('corpus/generated/01-basic-text-shapes.pptx');

test('Mac worker server requires bearer auth and serves verified Keynote artifact through bounded product protocol', async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'pb-keynote-worker-'));
  const token = 'server-test-token';
  const worker = await startRemoteKeynoteWorkerServer({
    host: '127.0.0.1',
    port: 0,
    authToken: token,
    artifactRoot,
    maxSourceBytes: 20 * 1024 * 1024,
    doctor: async () => ({ platform: 'darwin', available: true, keynoteInstalled: true, osascriptAvailable: true, sdefAvailable: true, version: '15.3' }),
    convert: async (_sourcePath, outputDir): Promise<TargetResult> => {
      const artifact = join(outputDir, 'converted.key');
      const previewPdf = join(outputDir, 'converted.pdf');
      await writeFile(artifact, 'NATIVE-KEYNOTE', 'utf8');
      await writeFile(previewPdf, 'PDF-PREVIEW', 'utf8');
      return { target: 'keynote', status: 'completed', native: true, verification: 'live', slideCount: 1, artifact, warnings: [], metadata: { previewPdf } };
    }
  });
  try {
    const healthUnauthorized = await fetch(`${worker.baseUrl}/v1/health`);
    assert.equal(healthUnauthorized.status, 401);
    const health = await fetch(`${worker.baseUrl}/v1/health`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(health.status, 200);
    assert.equal((await health.json() as { available: boolean }).available, true);

    const source = await (await fetch(`file://${fixture}`).catch(() => null));
    void source;
    const body = await import('node:fs/promises').then(({ readFile }) => readFile(fixture));
    const converted = await fetch(`${worker.baseUrl}/v1/convert`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'x-pb-filename': 'fixture.pptx',
        'content-type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'content-length': String(body.length)
      },
      body
    });
    assert.equal(converted.status, 200);
    const payload = await converted.json() as { native: boolean; downloadUrl: string; previewPdfUrl?: string };
    assert.equal(payload.native, true);
    assert.ok(payload.downloadUrl.endsWith('/output.key'));
    assert.ok(payload.previewPdfUrl?.endsWith('/preview.pdf'));

    const artifact = await fetch(payload.downloadUrl, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(artifact.status, 200);
    assert.equal(await artifact.text(), 'NATIVE-KEYNOTE');
    const preview = await fetch(payload.previewPdfUrl!, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(preview.status, 200);
    assert.equal(await preview.text(), 'PDF-PREVIEW');
  } finally {
    await worker.close();
  }
});

test('Mac worker server refuses non-loopback cleartext binding without TLS', async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'pb-keynote-worker-tls-'));
  await assert.rejects(
    startRemoteKeynoteWorkerServer({ host: '0.0.0.0', port: 0, authToken: 'token', artifactRoot, maxSourceBytes: 1024 }),
    /TLS/i
  );
});
