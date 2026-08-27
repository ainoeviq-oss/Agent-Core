import type { PresentationIR, SourceManifest } from '../../types/contracts.js';

export function buildPresentationIR(manifest: SourceManifest): PresentationIR {
  const unknowns: string[] = [];
  if (manifest.embeddedObjects.length > 0) unknowns.push('Embedded/OLE object editability is target-dependent.');
  if (manifest.featureCounts.animations > 0) unknowns.push('Animation mapping requires empirical target verification.');
  if (manifest.featureCounts.transitions > 0) unknowns.push('Transition mapping requires empirical target verification.');

  return {
    schemaVersion: 1,
    sourceSha256: manifest.source.sha256,
    pageSize: manifest.pageSize,
    fonts: manifest.fonts,
    masters: manifest.masters,
    layouts: manifest.layouts,
    slides: manifest.slides.map((slide) => ({
      index: slide.index,
      sourcePath: slide.path,
      elements: slide.elements,
      transition: slide.hasTransition ? 'unknown' : 'preserved',
      animation: slide.hasAnimationTiming ? 'unknown' : 'preserved',
      notes: slide.hasNotes
    })),
    unknowns
  };
}
