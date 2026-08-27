import type { SourceManifest, TargetResult } from '../../types/contracts.js';
import { convertWithLocalKeynote, mockKeynoteResult } from '../../workers/keynote/local.js';

export interface KeynoteConversionOptions {
  outputDir: string;
  mode: 'live' | 'mock';
  exportPdfPreview?: boolean;
}

export async function convertToKeynote(sourcePath: string, manifest: SourceManifest, options: KeynoteConversionOptions): Promise<TargetResult> {
  if (options.mode === 'mock') return mockKeynoteResult(manifest);
  return await convertWithLocalKeynote(sourcePath, manifest, {
    outputDir: options.outputDir,
    ...(options.exportPdfPreview !== undefined ? { exportPdfPreview: options.exportPdfPreview } : {})
  });
}
