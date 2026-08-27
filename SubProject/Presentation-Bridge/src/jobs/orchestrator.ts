import { randomUUID } from 'node:crypto';
import { copyFile, mkdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { BridgeConfig } from '../config/index.js';
import { analyzePptx } from '../pptx/preflight/analyze.js';
import { buildPresentationIR } from '../pptx/ir/build.js';
import { writeJson } from '../reports/io.js';
import { writeHtmlReport } from '../reports/html.js';
import type { ConversionReport, JobTarget, TargetResult } from '../types/contracts.js';
import { compareStructural } from '../fidelity/structural/compare.js';
import { convertToGoogleSlides, mockGoogleResult } from '../converters/google/adapter.js';
import { getGoogleAccessToken } from '../converters/google/oauth.js';
import { GoogleRestClient } from '../converters/google/rest.js';
import { downloadGoogleThumbnails } from '../converters/google/thumbnails.js';
import { convertToKeynote } from '../converters/keynote/adapter.js';
import { serializeError } from '../security/errors.js';
import { JobStateWriter } from './state.js';
import { renderPdfToPng, renderPptxWithLibreOffice } from '../renderers/source.js';
import { compareSlideSets, unavailableVisualReport } from '../fidelity/visual/pipeline.js';

export interface ConvertJobOptions {
  target: JobTarget;
  outputRoot?: string;
  googleMode?: 'live' | 'mock';
  keynoteMode?: 'live' | 'mock';
  exportKeynotePdfPreview?: boolean;
}

function makeJobId(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

function failedTarget(target: 'google' | 'keynote', error: unknown): TargetResult {
  return {
    target,
    status: 'failed',
    native: false,
    verification: 'live',
    warnings: [],
    error: serializeError(error),
    metadata: {}
  };
}

export async function runConversionJob(sourcePath: string, config: BridgeConfig, options: ConvertJobOptions): Promise<{ jobRoot: string; report: ConversionReport }> {
  const jobId = makeJobId();
  const root = resolve(options.outputRoot ?? config.runtimeRoot);
  const jobRoot = join(root, jobId);
  const sourceDir = join(jobRoot, 'source');
  const preflightDir = join(jobRoot, 'preflight');
  const googleDir = join(jobRoot, 'google');
  const keynoteDir = join(jobRoot, 'keynote');
  const fidelityDir = join(jobRoot, 'fidelity');
  await Promise.all([sourceDir, preflightDir, googleDir, keynoteDir, fidelityDir].map((dir) => mkdir(dir, { recursive: true })));
  const state = new JobStateWriter(join(jobRoot, 'job.json'), jobId);
  await state.init();
  const startedAt = new Date().toISOString();

  const copiedSource = join(sourceDir, basename(sourcePath));
  await copyFile(resolve(sourcePath), copiedSource);
  await state.set('preflight');
  const manifest = await analyzePptx(copiedSource, config);
  const ir = buildPresentationIR(manifest);
  await writeJson(join(preflightDir, 'source-manifest.json'), manifest);
  await writeJson(join(preflightDir, 'presentation-ir.json'), ir);
  await writeJson(join(preflightDir, 'compatibility-preflight.json'), {
    sourceSha256: manifest.source.sha256,
    warnings: [...manifest.warnings, ...ir.unknowns],
    featureCounts: manifest.featureCounts
  });

  const targets: Partial<Record<'google' | 'keynote', TargetResult>> = {};
  const requestedGoogle = options.target === 'all' || options.target === 'google';
  const requestedKeynote = options.target === 'all' || options.target === 'keynote';

  if (requestedGoogle) {
    await state.set('converting_google');
    if ((options.googleMode ?? 'live') === 'mock') {
      targets.google = mockGoogleResult(manifest);
    } else {
      try {
        await getGoogleAccessToken(config);
        targets.google = await convertToGoogleSlides(copiedSource, manifest, new GoogleRestClient(config), config);
      } catch (error) {
        targets.google = failedTarget('google', error);
      }
    }
    await writeJson(join(googleDir, 'result.json'), targets.google);
  }

  if (requestedKeynote) {
    await state.set('converting_keynote');
    try {
      const keynoteMode = options.keynoteMode ?? 'live';
      targets.keynote = await convertToKeynote(copiedSource, manifest, {
        outputDir: keynoteDir,
        mode: keynoteMode,
        exportPdfPreview: options.exportKeynotePdfPreview ?? keynoteMode === 'live'
      });
    } catch (error) {
      targets.keynote = failedTarget('keynote', error);
    }
    await writeJson(join(keynoteDir, 'result.json'), targets.keynote);
  }

  await state.set('verifying');
  const structural: ConversionReport['structural'] = {};
  if (targets.google) {
    structural.google = compareStructural(manifest, targets.google);
    await writeJson(join(fidelityDir, 'structural-google.json'), structural.google);
  }
  if (targets.keynote) {
    structural.keynote = compareStructural(manifest, targets.keynote);
    await writeJson(join(fidelityDir, 'structural-keynote.json'), structural.keynote);
  }

  const visual: ConversionReport['visual'] = {};
  let sourcePreviews: string[] | null = null;
  const getSourcePreviews = async (): Promise<string[]> => {
    if (sourcePreviews) return sourcePreviews;
    sourcePreviews = await renderPptxWithLibreOffice(copiedSource, join(fidelityDir, 'source-preview'));
    return sourcePreviews;
  };

  if (targets.google?.native && targets.google.verification === 'live' && targets.google.fileId) {
    try {
      const sourceSlides = await getSourcePreviews();
      await getGoogleAccessToken(config);
      const targetSlides = await downloadGoogleThumbnails(new GoogleRestClient(config), targets.google.fileId, join(googleDir, 'preview'));
      visual.google = await compareSlideSets('google', sourceSlides, targetSlides, join(fidelityDir, 'visual-google'));
    } catch (error) {
      visual.google = unavailableVisualReport('google', `Google visual fidelity unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    await writeJson(join(fidelityDir, 'visual-google.json'), visual.google);
  }

  if (targets.keynote?.native && targets.keynote.verification === 'live') {
    try {
      const sourceSlides = await getSourcePreviews();
      const previewPdf = typeof targets.keynote.metadata.previewPdf === 'string' ? targets.keynote.metadata.previewPdf : null;
      if (!previewPdf) throw new Error('Keynote PDF preview was not produced by the live worker.');
      const targetSlides = await renderPdfToPng(previewPdf, join(keynoteDir, 'preview'), 'slide');
      visual.keynote = await compareSlideSets('keynote', sourceSlides, targetSlides, join(fidelityDir, 'visual-keynote'));
    } catch (error) {
      visual.keynote = unavailableVisualReport('keynote', `Keynote visual fidelity unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    await writeJson(join(fidelityDir, 'visual-keynote.json'), visual.keynote);
  }

  const results = Object.values(targets).filter((value): value is TargetResult => Boolean(value));
  const failures = results.filter((result) => result.status === 'failed' || result.status === 'unavailable');
  const simulated = results.filter((result) => result.verification === 'mock');
  const successes = results.filter((result) => result.native && result.verification === 'live');
  const warnings = [
    ...manifest.warnings,
    ...results.flatMap((result) => result.warnings),
    ...(failures.length && successes.length ? ['One target succeeded while another target failed or is unavailable.'] : []),
    ...(simulated.length ? ['One or more targets used mock mode; mock results are never counted as native conversion success.'] : []),
    ...Object.values(visual).flatMap((report) => report?.warnings ?? [])
  ];

  const status: ConversionReport['status'] = failures.length === results.length && results.length > 0
    ? 'failed'
    : failures.length > 0 || warnings.length > 0 || simulated.length > 0
      ? 'completed_with_warnings'
      : 'completed';

  const artifacts = [
    join(preflightDir, 'source-manifest.json'),
    join(preflightDir, 'presentation-ir.json'),
    ...results.flatMap((result) => result.artifact ? [result.artifact] : []),
    ...(visual.google ? [join(fidelityDir, 'visual-google.json')] : []),
    ...(visual.keynote ? [join(fidelityDir, 'visual-keynote.json')] : [])
  ];

  const report: ConversionReport = {
    schemaVersion: 1,
    jobId,
    createdAt: startedAt,
    finishedAt: new Date().toISOString(),
    status,
    source: { ...manifest.source, slideCount: manifest.slideCount },
    targets,
    structural,
    visual,
    warnings,
    artifacts
  };
  await writeJson(join(jobRoot, 'conversion-report.json'), report);
  await writeHtmlReport(join(jobRoot, 'compatibility-report.html'), report);
  report.artifacts.push(join(jobRoot, 'compatibility-report.html'));
  await writeJson(join(jobRoot, 'conversion-report.json'), report);
  await state.set(status === 'failed' ? 'failed' : status);
  return { jobRoot, report };
}
