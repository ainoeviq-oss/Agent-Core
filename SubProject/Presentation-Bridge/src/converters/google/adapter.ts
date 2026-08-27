import { basename, parse } from 'node:path';
import type { BridgeConfig } from '../../config/index.js';
import { BridgeError, ErrorCode, serializeError } from '../../security/errors.js';
import type { SourceManifest, TargetResult } from '../../types/contracts.js';
import { GOOGLE_SLIDES_MIME, PPTX_MIME } from './constants.js';
import { summarizeGooglePresentation } from './inspect.js';
import { GoogleRestClient } from './rest.js';

export async function verifyGoogleImportCapability(client: GoogleRestClient): Promise<void> {
  const about = await client.aboutImportFormats();
  const targets = about.importFormats?.[PPTX_MIME] ?? [];
  if (!targets.includes(GOOGLE_SLIDES_MIME)) {
    throw new BridgeError(ErrorCode.GOOGLE_IMPORT_UNAVAILABLE, 'Authenticated Drive does not advertise PPTX → Google Slides import support.', { sourceMime: PPTX_MIME, advertisedTargets: targets });
  }
}

export async function convertToGoogleSlides(sourcePath: string, manifest: SourceManifest, client: GoogleRestClient, config: BridgeConfig): Promise<TargetResult> {
  try {
    await verifyGoogleImportCapability(client);
    const file = await client.createNativeSlidesFromPptx(sourcePath, parse(basename(sourcePath)).name, config.googleFolderId);
    if (!file.id) throw new BridgeError(ErrorCode.GOOGLE_UPLOAD_FAILED, 'Drive conversion returned no file ID.');
    if (file.mimeType !== GOOGLE_SLIDES_MIME) throw new BridgeError(ErrorCode.GOOGLE_TARGET_NOT_NATIVE, 'Drive returned a non-native target MIME type.', { fileId: file.id, mimeType: file.mimeType });
    const presentation = await client.getPresentation(file.id);
    const summary = summarizeGooglePresentation(presentation);
    const warnings: string[] = [];
    if (summary.slideCount !== manifest.slideCount) warnings.push(`Slide count changed: source=${manifest.slideCount}, target=${summary.slideCount}`);
    return {
      target: 'google', status: warnings.length ? 'completed_with_warnings' : 'completed', native: true, verification: 'live', slideCount: summary.slideCount,
      fileId: file.id, ...(file.webViewLink ? { webViewLink: file.webViewLink } : {}), warnings,
      metadata: { mimeType: file.mimeType, name: file.name, createdTime: file.createdTime, summary }
    };
  } catch (error) {
    return { target: 'google', status: 'failed', native: false, verification: 'live', warnings: [], error: serializeError(error), metadata: {} };
  }
}

export function mockGoogleResult(manifest: SourceManifest): TargetResult {
  return { target: 'google', status: 'simulated', native: false, verification: 'mock', slideCount: manifest.slideCount,
    warnings: ['Mock contract only. No Google file was created and native conversion was not verified.'],
    metadata: { simulatedSummary: { slideCount: manifest.slideCount, images: manifest.featureCounts.images, tables: manifest.featureCounts.tables, charts: manifest.featureCounts.charts } } };
}
