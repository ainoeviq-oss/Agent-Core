import type { SecurityLimits } from '../../types/contracts.js';
import { SafeZipArchive } from './zip.js';

export async function inspectZip(path: string, limits: SecurityLimits) {
  const zip = await SafeZipArchive.open(path, limits);
  return {
    sourceBytes: zip.sourceBytes,
    entries: zip.entries.map(({ name, compressedSize, uncompressedSize }) => ({ name, compressedSize, uncompressedSize })),
    compressedBytes: zip.compressedBytes,
    expandedBytes: zip.expandedBytes
  };
}
