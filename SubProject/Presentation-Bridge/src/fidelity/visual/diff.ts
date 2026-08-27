import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import sharp from 'sharp';
import type { VisualDiffReport } from '../../types/contracts.js';

async function rawRgba(path: string, width: number, height: number): Promise<Buffer> {
  return (await sharp(path).ensureAlpha().resize(width, height, { fit: 'fill' }).raw().toBuffer()) as Buffer;
}

export async function compareImages(sourceImage: string, targetImage: string, diffImage?: string): Promise<VisualDiffReport> {
  const sourceMeta = await sharp(sourceImage).metadata();
  if (!sourceMeta.width || !sourceMeta.height) throw new Error('Source image has no raster dimensions.');
  const width = sourceMeta.width;
  const height = sourceMeta.height;
  const source = await rawRgba(sourceImage, width, height);
  const target = await rawRgba(targetImage, width, height);
  const diff = Buffer.alloc(width * height * 4);
  let mismatchedPixels = 0;
  const threshold = 26;

  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const offset = pixel * 4;
    const dr = Math.abs(source[offset]! - target[offset]!);
    const dg = Math.abs(source[offset + 1]! - target[offset + 1]!);
    const db = Math.abs(source[offset + 2]! - target[offset + 2]!);
    const da = Math.abs(source[offset + 3]! - target[offset + 3]!);
    const mismatch = Math.max(dr, dg, db, da) > threshold;
    if (mismatch) mismatchedPixels += 1;
    diff[offset] = mismatch ? 255 : 0;
    diff[offset + 1] = mismatch ? 255 : 0;
    diff[offset + 2] = mismatch ? 255 : 0;
    diff[offset + 3] = mismatch ? 255 : 40;
  }

  const total = width * height;
  const mismatchRatio = total === 0 ? 0 : mismatchedPixels / total;
  if (diffImage) {
    await mkdir(dirname(diffImage), { recursive: true });
    await sharp(diff, { raw: { width, height, channels: 4 } }).png().toFile(diffImage);
  }
  return {
    sourceImage,
    targetImage,
    width,
    height,
    mismatchedPixels,
    mismatchRatio: Number(mismatchRatio.toFixed(8)),
    similarity: Number((1 - mismatchRatio).toFixed(8)),
    ...(diffImage ? { diffImage } : {})
  };
}
