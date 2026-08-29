import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../../src/config/index.js';
import { convertToKeynote, keynoteTargetDoctor } from '../../src/converters/keynote/adapter.js';
import type { SourceManifest } from '../../src/types/contracts.js';

const sourcePath = resolve('corpus/generated/01-basic-text-shapes.pptx');
const manifest = { slideCount: 1 } as SourceManifest;

test('Keynote adapter selects configured remote worker and returns downloaded native artifact', async () => {
  const token = 'adapter-worker-token';
  let baseUrl = '';
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) return void response.writeHead(401).end();
    if (request.method === 'GET' && request.url === '/v1/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      return void response.end(JSON.stringify({ available: true, platform: 'darwin', version: '15.3' }));
    }
    if (request.method === 'POST' && request.url === '/v1/convert') {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ native: true, status: 'completed', slideCount: 1, downloadUrl: `${baseUrl}/v1/artifacts/job/output.key`, warnings: [] }));
      });
      return;
    }
    if (request.method === 'GET' && request.url === '/v1/artifacts/job/output.key') {
      response.writeHead(200);
      return void response.end('KEYNOTE-REMOTE');
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const config = {
      ...loadConfig(resolve('.')),
      keynoteWorker: 'remote' as const,
      keynoteRemoteUrl: baseUrl,
      keynoteRemoteToken: token,
      keynoteRemoteAllowInsecureLoopback: true
    };
    const doctor = await keynoteTargetDoctor(config);
    assert.equal(doctor.available, true);
    assert.equal(doctor.worker, 'remote');
    const outputDir = await mkdtemp(join(tmpdir(), 'pb-adapter-remote-'));
    const result = await convertToKeynote(sourcePath, manifest, { outputDir, mode: 'live' }, config);
    assert.equal(result.native, true);
    assert.ok(result.artifact?.endsWith('.key'));
    assert.equal(result.metadata.remote, true);
  } finally {
    await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
});
