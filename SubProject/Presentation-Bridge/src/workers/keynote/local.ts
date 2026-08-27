import { execFile } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { SourceManifest, TargetResult } from '../../types/contracts.js';
import { BridgeError, ErrorCode, serializeError } from '../../security/errors.js';
import { keynoteDoctor } from './doctor.js';

const execFileAsync = promisify(execFile);
const assetRoot = fileURLToPath(new URL('./assets/', import.meta.url));

export interface KeynoteWorkerOptions {
  outputDir: string;
  timeoutMs?: number;
  exportPdfPreview?: boolean;
}

export async function convertWithLocalKeynote(
  sourcePath: string,
  manifest: SourceManifest,
  options: KeynoteWorkerOptions
): Promise<TargetResult> {
  const doctor = await keynoteDoctor();
  if (!doctor.available) {
    return {
      target: 'keynote',
      status: 'unavailable',
      native: false,
      verification: 'unavailable',
      warnings: [],
      error: serializeError(new BridgeError(ErrorCode.KEYNOTE_WORKER_UNAVAILABLE, doctor.reason ?? 'Keynote worker is unavailable.', { ...doctor })),
      metadata: { doctor }
    };
  }

  const outputDir = options.outputDir;
  await mkdir(outputDir, { recursive: true });
  const outputKey = join(outputDir, `${parse(basename(sourcePath)).name}.key`);
  const convertScript = join(assetRoot, 'convert.applescript');
  const timeout = options.timeoutMs ?? 120_000;

  try {
    const result = await execFileAsync('/usr/bin/osascript', [convertScript, sourcePath, outputKey], {
      timeout,
      maxBuffer: 1024 * 1024
    });
    const info = await stat(outputKey).catch(() => null);
    if (!info) throw new BridgeError(ErrorCode.KEYNOTE_OUTPUT_MISSING, 'Keynote automation exited without creating the .key artifact.', { outputKey });
    if (extname(outputKey).toLowerCase() !== '.key') throw new BridgeError(ErrorCode.KEYNOTE_SAVE_FAILED, 'Worker output does not have .key extension.', { outputKey });
    const slideCount = Number.parseInt(result.stdout.trim(), 10);
    const warnings: string[] = [];
    if (Number.isFinite(slideCount) && slideCount !== manifest.slideCount) {
      warnings.push(`Slide count changed: source=${manifest.slideCount}, target=${slideCount}`);
    }

    const metadata: Record<string, unknown> = {
      doctor,
      outputKind: info.isDirectory() ? 'package-directory' : 'file',
      stderr: result.stderr.trim() || undefined
    };

    if (options.exportPdfPreview) {
      const pdfPath = join(outputDir, `${parse(outputKey).name}.pdf`);
      const pdfScript = join(assetRoot, 'export-pdf.applescript');
      try {
        await execFileAsync('/usr/bin/osascript', [pdfScript, outputKey, pdfPath], { timeout, maxBuffer: 1024 * 1024 });
        if (await stat(pdfPath).catch(() => null)) metadata.previewPdf = pdfPath;
      } catch (error) {
        warnings.push(`Keynote PDF preview export failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return {
      target: 'keynote',
      status: warnings.length ? 'completed_with_warnings' : 'completed',
      native: true,
      verification: 'live',
      ...(Number.isFinite(slideCount) ? { slideCount } : {}),
      artifact: outputKey,
      warnings,
      metadata
    };
  } catch (error) {
    const bridgeError = error instanceof BridgeError
      ? error
      : new BridgeError(ErrorCode.KEYNOTE_SAVE_FAILED, `Keynote conversion failed: ${error instanceof Error ? error.message : String(error)}`, {}, { cause: error });
    return {
      target: 'keynote',
      status: 'failed',
      native: false,
      verification: 'live',
      warnings: [],
      error: serializeError(bridgeError),
      metadata: { doctor }
    };
  }
}

export function mockKeynoteResult(manifest: SourceManifest): TargetResult {
  return {
    target: 'keynote',
    status: 'simulated',
    native: false,
    verification: 'mock',
    slideCount: manifest.slideCount,
    warnings: ['Mock contract only. No .key artifact was created and native Keynote conversion was not verified.'],
    metadata: { simulatedSlideCount: manifest.slideCount }
  };
}
