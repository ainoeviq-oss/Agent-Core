import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { RemoteKeynoteWorker, remoteKeynoteDoctor, validateRemoteKeynoteWorkerUrl } from '../../src/converters/keynote/remote.js';
import type { SourceManifest } from '../../src/types/contracts.js';

const sourcePath = resolve('corpus/generated/01-basic-text-shapes.pptx');
const manifest = { slideCount: 1 } as SourceManifest;

test('remote Keynote worker uses bearer auth, verifies native response, and downloads a local .key artifact', async () => {
  const token = 'worker-test-token';
  let uploadedBytes = 0;
  let baseUrl = '';
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end('unauthorized');
      return;
    }
    if (request.method === 'GET' && request.url === '/v1/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ available: true, platform: 'darwin', keynoteInstalled: true, osascriptAvailable: true, sdefAvailable: true, version: '15.3' }));
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/convert') {
      request.on('data', (chunk: Buffer) => { uploadedBytes += chunk.length; });
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ native: true, status: 'completed', slideCount: 1, downloadUrl: `${baseUrl}/v1/artifacts/job/output.key`, previewPdfUrl: `${baseUrl}/v1/artifacts/job/preview.pdf`, warnings: [], metadata: { workerVersion: 'test' } }));
      });
      return;
    }
    if (request.method === 'GET' && request.url === '/v1/artifacts/job/output.key') {
      response.writeHead(200, { 'content-type': 'application/x-iwork-keynote-sffkey' });
      response.end('KEYNOTE-TEST-ARTIFACT');
      return;
    }
    if (request.method === 'GET' && request.url === '/v1/artifacts/job/preview.pdf') {
      response.writeHead(200, { 'content-type': 'application/pdf' });
      response.end('PDF-TEST-PREVIEW');
      return;
    }
    response.writeHead(404).end('not found');
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const outputDir = await mkdtemp(join(tmpdir(), 'pb-remote-keynote-'));
    const worker = new RemoteKeynoteWorker({ baseUrl, token, allowInsecureLoopback: true });
    const doctor = await remoteKeynoteDoctor({ baseUrl, token, allowInsecureLoopback: true });
    assert.equal(doctor.available, true);
    const result = await worker.convert(sourcePath, manifest, { outputDir });
    assert.equal(result.native, true);
    assert.equal(result.verification, 'live');
    assert.ok(result.artifact?.endsWith('.key'));
    assert.equal((await readFile(result.artifact!)).toString(), 'KEYNOTE-TEST-ARTIFACT');
    assert.equal(typeof result.metadata.previewPdf, 'string');
    assert.equal((await readFile(result.metadata.previewPdf as string)).toString(), 'PDF-TEST-PREVIEW');
    assert.ok(uploadedBytes > 0);
  } finally {
    await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
});

test('remote Keynote worker rejects insecure non-loopback HTTP endpoints', () => {
  assert.throws(() => validateRemoteKeynoteWorkerUrl('http://example.com'), /HTTPS/i);
  assert.doesNotThrow(() => validateRemoteKeynoteWorkerUrl('https://worker.example.com'));
  assert.doesNotThrow(() => validateRemoteKeynoteWorkerUrl('http://127.0.0.1:4815', true));
});
