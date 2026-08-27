import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { TargetName, VisualDiffReport } from '../../types/contracts.js';
import { compareImages } from './diff.js';

export interface TargetVisualReport {
  target: TargetName;
  verification: 'live' | 'unavailable';
  sourceSlides: number;
  targetSlides: number;
  comparedSlides: number;
  averageSimilarity: number | null;
  slides: VisualDiffReport[];
  warnings: string[];
}

export async function compareSlideSets(
  target: TargetName,
  sourceSlides: string[],
  targetSlides: string[],
  outputDir: string
): Promise<TargetVisualReport> {
  await mkdir(outputDir, { recursive: true });
  const count = Math.min(sourceSlides.length, targetSlides.length);
  const slides: VisualDiffReport[] = [];
  for (let index = 0; index < count; index += 1) {
    const source = sourceSlides[index]!;
    const targetImage = targetSlides[index]!;
    const diff = join(outputDir, `slide-${String(index + 1).padStart(3, '0')}-diff.png`);
    slides.push(await compareImages(source, targetImage, diff));
  }
  const warnings: string[] = [];
  if (sourceSlides.length !== targetSlides.length) {
    warnings.push(`Preview slide count differs: source=${sourceSlides.length}, target=${targetSlides.length}.`);
  }
  return {
    target,
    verification: 'live',
    sourceSlides: sourceSlides.length,
    targetSlides: targetSlides.length,
    comparedSlides: count,
    averageSimilarity: slides.length
      ? Number((slides.reduce((sum, slide) => sum + slide.similarity, 0) / slides.length).toFixed(8))
      : null,
    slides,
    warnings
  };
}

export function unavailableVisualReport(target: TargetName, reason: string): TargetVisualReport {
  return {
    target,
    verification: 'unavailable',
    sourceSlides: 0,
    targetSlides: 0,
    comparedSlides: 0,
    averageSimilarity: null,
    slides: [],
    warnings: [reason]
  };
}
