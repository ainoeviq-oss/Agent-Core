import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { BridgeConfig } from '../config/index.js';
import { authorizeGoogle } from '../converters/google/oauth.js';
import { googleDoctor } from '../converters/google/doctor.js';
import { sourceRendererDoctor } from '../renderers/source.js';
import { auditSourceIsolation } from '../security/isolation.js';
import { serializeError } from '../security/errors.js';
import { keynoteTargetDoctor } from '../converters/keynote/adapter.js';
import { makeJobId, runConversionJob } from '../jobs/orchestrator.js';
import type { ConversionProgressEvent, ConversionReport, JobLifecycleState } from '../types/contracts.js';
import type { ApplicationJobSnapshot, BridgeDoctorResult, JobHistoryItem, StartConversionRequest } from './contracts.js';
export type { ApplicationJobSnapshot, BridgeDoctorResult, JobHistoryItem, StartConversionRequest } from './contracts.js';

interface JobEntry {
  controller: AbortController;
  snapshot: ApplicationJobSnapshot;
  promise: Promise<ApplicationJobSnapshot>;
}

type ProgressListener = (event: ConversionProgressEvent) => void;

function isJobState(value: unknown): value is JobLifecycleState {
  return typeof value === 'string' && [
    'queued',
    'preflight',
    'converting_google',
    'converting_keynote',
    'verifying',
    'completed',
    'completed_with_warnings',
    'failed',
    'cancelled'
  ].includes(value);
}

export class PresentationBridgeService {
  private readonly jobs = new Map<string, JobEntry>();
  private readonly progressListeners = new Set<ProgressListener>();

  constructor(readonly config: BridgeConfig) {}

  onProgress(listener: ProgressListener): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  private publish(event: ConversionProgressEvent): void {
    const entry = this.jobs.get(event.jobId);
    if (entry) {
      entry.snapshot = {
        ...entry.snapshot,
        state: event.stage,
        percent: event.percent,
        message: event.message,
        updatedAt: event.at
      };
    }
    for (const listener of this.progressListeners) listener(event);
  }

  startConversion(request: StartConversionRequest): { jobId: string } {
    const jobId = makeJobId();
    const controller = new AbortController();
    const initial: ApplicationJobSnapshot = {
      jobId,
      state: 'queued',
      percent: 0,
      message: 'Conversion queued.',
      updatedAt: new Date().toISOString()
    };
    const entry: JobEntry = {
      controller,
      snapshot: initial,
      promise: Promise.resolve(initial)
    };
    this.jobs.set(jobId, entry);

    entry.promise = runConversionJob(request.sourcePath, this.config, {
      jobId,
      target: request.target,
      ...(request.outputRoot ? { outputRoot: request.outputRoot } : {}),
      ...(request.googleMode ? { googleMode: request.googleMode } : {}),
      ...(request.keynoteMode ? { keynoteMode: request.keynoteMode } : {}),
      ...(request.exportKeynotePdfPreview !== undefined ? { exportKeynotePdfPreview: request.exportKeynotePdfPreview } : {}),
      signal: controller.signal,
      onProgress: (event) => this.publish(event)
    }).then(({ jobRoot, report }) => {
      entry.snapshot = {
        ...entry.snapshot,
        state: report.status,
        percent: 100,
        message: report.status === 'failed' ? 'Conversion failed.' : 'Conversion finished.',
        updatedAt: report.finishedAt,
        jobRoot,
        report
      };
      return entry.snapshot;
    }).catch((error: unknown) => {
      const cancelled = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
      const serialized = serializeError(error);
      entry.snapshot = {
        ...entry.snapshot,
        state: cancelled ? 'cancelled' : 'failed',
        message: cancelled ? 'Conversion cancelled by user.' : serialized.message,
        updatedAt: new Date().toISOString(),
        ...(cancelled ? {} : { error: serialized })
      };
      if (!cancelled) {
        this.publish({
          jobId,
          stage: 'failed',
          percent: entry.snapshot.percent,
          message: serialized.message,
          at: entry.snapshot.updatedAt
        });
      }
      return entry.snapshot;
    });

    return { jobId };
  }

  getJob(jobId: string): ApplicationJobSnapshot | undefined {
    return this.jobs.get(jobId)?.snapshot;
  }

  hasActiveJobs(): boolean {
    for (const entry of this.jobs.values()) {
      if (!['completed', 'completed_with_warnings', 'failed', 'cancelled'].includes(entry.snapshot.state)) return true;
    }
    return false;
  }

  async waitForJob(jobId: string): Promise<ApplicationJobSnapshot> {
    const entry = this.jobs.get(jobId);
    if (!entry) throw new Error(`Unknown job: ${jobId}`);
    return await entry.promise;
  }

  cancel(jobId: string): boolean {
    const entry = this.jobs.get(jobId);
    if (!entry) return false;
    if (['completed', 'completed_with_warnings', 'failed', 'cancelled'].includes(entry.snapshot.state)) return false;
    entry.controller.abort();
    return true;
  }

  async listHistory(limit = 50): Promise<JobHistoryItem[]> {
    await mkdir(this.config.runtimeRoot, { recursive: true });
    const entries = await readdir(this.config.runtimeRoot, { withFileTypes: true });
    const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
    const history: JobHistoryItem[] = [];

    for (const jobId of directories.slice(0, Math.max(1, Math.min(limit, 200)))) {
      const jobRoot = join(this.config.runtimeRoot, jobId);
      try {
        const stateRecord = JSON.parse(await readFile(join(jobRoot, 'job.json'), 'utf8')) as {
          state?: unknown;
          updatedAt?: unknown;
        };
        if (!isJobState(stateRecord.state)) continue;
        let report: ConversionReport | undefined;
        try {
          report = JSON.parse(await readFile(join(jobRoot, 'conversion-report.json'), 'utf8')) as ConversionReport;
        } catch {
          report = undefined;
        }
        history.push({
          jobId,
          state: stateRecord.state,
          updatedAt: typeof stateRecord.updatedAt === 'string' ? stateRecord.updatedAt : new Date(0).toISOString(),
          jobRoot,
          ...(report ? {
            sourceFilename: report.source.filename,
            finishedAt: report.finishedAt,
            reportPath: join(jobRoot, 'conversion-report.json'),
            htmlReportPath: join(jobRoot, 'compatibility-report.html'),
            targets: report.targets
          } : {})
        });
      } catch {
        // Ignore incomplete/corrupt job directories instead of inventing history.
      }
    }
    return history;
  }

  async authorizeGoogle(): Promise<void> {
    await authorizeGoogle(this.config);
  }

  async doctor(): Promise<BridgeDoctorResult> {
    const [google, keynote, sourceRenderer, isolation] = await Promise.all([
      googleDoctor(this.config),
      keynoteTargetDoctor(this.config),
      sourceRendererDoctor(),
      auditSourceIsolation(this.config.cwd)
    ]);
    return {
      project: 'Presentation-Bridge',
      version: '0.2.0',
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      isolation,
      google,
      keynote,
      sourceRenderer
    };
  }
}
