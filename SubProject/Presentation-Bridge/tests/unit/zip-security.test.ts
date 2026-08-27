import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeStoredZip } from '../../scripts/zip-store.js';
import { SafeZipArchive } from '../../src/pptx/opc/zip.js';
import { ErrorCode, BridgeError } from '../../src/security/errors.js';

const limits = { maxSourceBytes: 10_000_000, maxExpandedBytes: 10_000_000, maxEntryBytes: 5_000_000, maxZipEntries: 1000 };

test('safe ZIP reader validates CRC and content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-zip-'));
  const path = join(dir, 'ok.zip');
  await writeStoredZip(path, [{ name: 'hello.txt', data: Buffer.from('hello') }]);
  const zip = await SafeZipArchive.open(path, limits);
  assert.equal(zip.text('hello.txt'), 'hello');
});

test('ZIP path traversal is rejected before extraction', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-zip-'));
  const path = join(dir, 'bad.zip');
  await writeStoredZip(path, [{ name: '../evil.txt', data: Buffer.from('no') }]);
  await assert.rejects(() => SafeZipArchive.open(path, limits), (error: unknown) => error instanceof BridgeError && error.code === ErrorCode.SOURCE_PATH_TRAVERSAL);
});

test('CRC mismatch is rejected when entry is read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-zip-'));
  const path = join(dir, 'crc.zip');
  await writeStoredZip(path, [{ name: 'a.txt', data: Buffer.from('abc') }]);
  const raw = await readFile(path);
  const nameLen = raw.readUInt16LE(26);
  const extraLen = raw.readUInt16LE(28);
  const dataOffset = 30 + nameLen + extraLen;
  raw[dataOffset] = raw[dataOffset]! ^ 0xff;
  await writeFile(path, raw);
  const zip = await SafeZipArchive.open(path, limits);
  assert.throws(() => zip.read('a.txt'), (error: unknown) => error instanceof BridgeError && error.code === ErrorCode.SOURCE_INVALID_PPTX);
});

test('declared expanded entry above configured limit is rejected before read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-zip-'));
  const path = join(dir, 'large.zip');
  await writeStoredZip(path, [{ name: 'big.bin', data: Buffer.alloc(1024) }]);
  await assert.rejects(() => SafeZipArchive.open(path, { ...limits, maxEntryBytes: 100 }), (error: unknown) => error instanceof BridgeError && error.code === ErrorCode.SOURCE_ZIP_BOMB_RISK);
});

test('encrypted ZIP flag is rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-zip-'));
  const path = join(dir, 'encrypted.zip');
  await writeStoredZip(path, [{ name: 'a.txt', data: Buffer.from('abc') }]);
  const raw = await readFile(path);
  const central = raw.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
  assert.ok(central >= 0);
  raw.writeUInt16LE(raw.readUInt16LE(central + 8) | 0x1, central + 8);
  await writeFile(path, raw);
  await assert.rejects(() => SafeZipArchive.open(path, limits), (error: unknown) => error instanceof BridgeError && error.code === ErrorCode.SOURCE_UNSUPPORTED_ENCRYPTION);
});
