import { inflateRawSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import type { SecurityLimits, ZipEntryEvidence } from '../../types/contracts.js';
import { BridgeError, ErrorCode } from '../../security/errors.js';
import { validateZipEntryPath } from '../../security/paths.js';

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function findEocd(buffer: Buffer): number {
  const min = Math.max(0, buffer.length - 65_557);
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

export interface ZipEntry extends ZipEntryEvidence {
  method: number;
  flags: number;
  crc32: number;
  localHeaderOffset: number;
}

export class SafeZipArchive {
  readonly entries: ZipEntry[];
  readonly sourceBytes: number;
  readonly compressedBytes: number;
  readonly expandedBytes: number;
  private readonly byName: Map<string, ZipEntry>;

  private constructor(private readonly buffer: Buffer, entries: ZipEntry[]) {
    this.entries = entries;
    this.sourceBytes = buffer.length;
    this.compressedBytes = entries.reduce((sum, entry) => sum + entry.compressedSize, 0);
    this.expandedBytes = entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
    this.byName = new Map(entries.map((entry) => [entry.name, entry]));
  }

  static async open(path: string, limits: SecurityLimits): Promise<SafeZipArchive> {
    const buffer = await readFile(path);
    if (buffer.length > limits.maxSourceBytes) {
      throw new BridgeError(ErrorCode.SOURCE_ZIP_BOMB_RISK, 'PPTX exceeds configured source size limit', { bytes: buffer.length, maxSourceBytes: limits.maxSourceBytes });
    }
    const eocd = findEocd(buffer);
    if (eocd < 0) throw new BridgeError(ErrorCode.SOURCE_INVALID_PPTX, 'ZIP end-of-central-directory record is missing.');
    const totalEntries = buffer.readUInt16LE(eocd + 10);
    const centralSize = buffer.readUInt32LE(eocd + 12);
    const centralOffset = buffer.readUInt32LE(eocd + 16);
    if (totalEntries > limits.maxZipEntries) throw new BridgeError(ErrorCode.SOURCE_ZIP_BOMB_RISK, 'PPTX contains too many ZIP entries', { totalEntries, maxZipEntries: limits.maxZipEntries });
    if (centralOffset + centralSize > buffer.length) throw new BridgeError(ErrorCode.SOURCE_INVALID_PPTX, 'ZIP central directory points outside the source file.');

    const entries: ZipEntry[] = [];
    let cursor = centralOffset;
    let expandedBytes = 0;
    for (let index = 0; index < totalEntries; index += 1) {
      if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== SIG_CENTRAL) {
        throw new BridgeError(ErrorCode.SOURCE_INVALID_PPTX, 'Malformed ZIP central directory.');
      }
      const flags = buffer.readUInt16LE(cursor + 8);
      const method = buffer.readUInt16LE(cursor + 10);
      const expectedCrc = buffer.readUInt32LE(cursor + 16);
      const compressedSize = buffer.readUInt32LE(cursor + 20);
      const uncompressedSize = buffer.readUInt32LE(cursor + 24);
      const filenameLength = buffer.readUInt16LE(cursor + 28);
      const extraLength = buffer.readUInt16LE(cursor + 30);
      const commentLength = buffer.readUInt16LE(cursor + 32);
      const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
      const endName = cursor + 46 + filenameLength;
      if (endName > buffer.length) throw new BridgeError(ErrorCode.SOURCE_INVALID_PPTX, 'Malformed ZIP filename record.');
      const name = buffer.subarray(cursor + 46, endName).toString('utf8');
      validateZipEntryPath(name);
      if ((flags & 0x1) !== 0) throw new BridgeError(ErrorCode.SOURCE_UNSUPPORTED_ENCRYPTION, `Encrypted ZIP entry is not supported: ${name}`);
      if (![0, 8].includes(method)) throw new BridgeError(ErrorCode.SOURCE_INVALID_PPTX, `Unsupported ZIP compression method ${method} in ${name}`);
      if (uncompressedSize > limits.maxEntryBytes) throw new BridgeError(ErrorCode.SOURCE_ZIP_BOMB_RISK, 'PPTX entry exceeds configured expanded entry limit', { entry: name, bytes: uncompressedSize, maxEntryBytes: limits.maxEntryBytes });
      expandedBytes += uncompressedSize;
      if (expandedBytes > limits.maxExpandedBytes) throw new BridgeError(ErrorCode.SOURCE_ZIP_BOMB_RISK, 'PPTX expanded size exceeds configured limit', { expandedBytes, maxExpandedBytes: limits.maxExpandedBytes });
      entries.push({ name, flags, method, crc32: expectedCrc, compressedSize, uncompressedSize, localHeaderOffset });
      cursor = endName + extraLength + commentLength;
    }
    return new SafeZipArchive(buffer, entries);
  }

  has(name: string): boolean { return this.byName.has(name); }
  names(): string[] { return this.entries.map((entry) => entry.name); }

  read(name: string): Buffer | null {
    const entry = this.byName.get(name);
    if (!entry) return null;
    const offset = entry.localHeaderOffset;
    if (offset + 30 > this.buffer.length || this.buffer.readUInt32LE(offset) !== SIG_LOCAL) {
      throw new BridgeError(ErrorCode.SOURCE_INVALID_PPTX, `Malformed local ZIP header for ${name}`);
    }
    const filenameLength = this.buffer.readUInt16LE(offset + 26);
    const extraLength = this.buffer.readUInt16LE(offset + 28);
    const dataStart = offset + 30 + filenameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > this.buffer.length) throw new BridgeError(ErrorCode.SOURCE_INVALID_PPTX, `ZIP entry data points outside source: ${name}`);
    const compressed = this.buffer.subarray(dataStart, dataEnd);
    const output = entry.method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: entry.uncompressedSize + 1 });
    if (output.length !== entry.uncompressedSize) throw new BridgeError(ErrorCode.SOURCE_INVALID_PPTX, `ZIP entry size mismatch: ${name}`);
    if (crc32(output) !== entry.crc32) throw new BridgeError(ErrorCode.SOURCE_INVALID_PPTX, `ZIP CRC mismatch: ${name}`);
    return output;
  }

  text(name: string): string | null {
    const data = this.read(name);
    return data ? data.toString('utf8') : null;
  }
}
