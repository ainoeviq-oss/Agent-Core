import { execFile } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { basename, dirname, join, parse } from 'node:path';
import { promisify } from 'node:util';
import { BridgeError, ErrorCode } from '../security/errors.js';

const execFileAsync = promisify(execFile);

async function commandPath(command: string): Promise<string | null> {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    const { stdout } = await execFileAsync(locator, [command], { timeout: 3000 });
    return stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
  } catch { return null; }
}

export async function sourceRendererDoctor(): Promise<Record<string, unknown>> {
  const soffice = await commandPath(process.platform === 'win32' ? 'soffice.exe' : 'soffice');
  const pdftoppm = await commandPath(process.platform === 'win32' ? 'pdftoppm.exe' : 'pdftoppm');
  return { soffice, pdftoppm, available: Boolean(soffice && pdftoppm) };
}

export async function renderPdfToPng(pdfPath: string, outputDir: string, prefixName = 'slide'): Promise<string[]> {
  const doctor = await sourceRendererDoctor();
  const pdftoppm = typeof doctor.pdftoppm === 'string' ? doctor.pdftoppm : null;
  if (!pdftoppm) {
    throw new BridgeError(ErrorCode.FIDELITY_RENDER_FAILED, 'pdftoppm is required for PDF slide rendering.', { doctor });
  }
  await mkdir(outputDir, { recursive: true });
  const prefix = join(outputDir, prefixName);
  await execFileAsync(pdftoppm, ['-png', '-r', '144', pdfPath, prefix], { timeout: 120_000 });
  const { readdir } = await import('node:fs/promises');
  return (await readdir(outputDir))
    .filter((name) => new RegExp(`^${prefixName}-\\d+\\.png$`, 'i').test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((name) => join(outputDir, name));
}

export async function renderPptxWithLibreOffice(sourcePath: string, outputDir: string): Promise<string[]> {
  const doctor = await sourceRendererDoctor();
  const soffice = typeof doctor.soffice === 'string' ? doctor.soffice : null;
  if (!soffice) {
    throw new BridgeError(ErrorCode.FIDELITY_RENDER_FAILED, 'LibreOffice is required for local source slide rendering.', { doctor });
  }
  await mkdir(outputDir, { recursive: true });
  await execFileAsync(soffice, ['--headless', '--convert-to', 'pdf', '--outdir', outputDir, sourcePath], { timeout: 120_000 });
  const pdf = join(outputDir, `${parse(basename(sourcePath)).name}.pdf`);
  await access(pdf);
  return renderPdfToPng(pdf, outputDir, 'slide');
}
