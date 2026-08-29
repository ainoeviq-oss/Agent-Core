import type {
  ConversionProgressEvent,
  ConversionReport,
  JobLifecycleState,
  JobTarget
} from '../types/contracts.js';

export interface StartConversionRequest {
  sourcePath: string;
  target: JobTarget;
  outputRoot?: string;
  googleMode?: 'live' | 'mock';
  keynoteMode?: 'live' | 'mock';
  exportKeynotePdfPreview?: boolean;
}

export interface ApplicationJobSnapshot {
  jobId: string;
  state: JobLifecycleState;
  percent: number;
  message: string;
  updatedAt: string;
  jobRoot?: string;
  report?: ConversionReport;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

export interface JobHistoryItem {
  jobId: string;
  state: JobLifecycleState;
  updatedAt: string;
  sourceFilename?: string;
  finishedAt?: string;
  jobRoot: string;
  reportPath?: string;
  htmlReportPath?: string;
  targets?: ConversionReport['targets'];
}

export interface BridgeDoctorResult {
  project: 'Presentation-Bridge';
  version: string;
  node: string;
  platform: string;
  arch: string;
  isolation: { clean: boolean; findings: Array<{ path: string; match: string }> };
  google: Record<string, unknown>;
  keynote: {
    worker?: 'local' | 'remote';
    baseUrl?: string;
    platform?: string;
    available: boolean;
    keynoteInstalled?: boolean;
    osascriptAvailable?: boolean;
    sdefAvailable?: boolean;
    version?: string;
    scriptingSaveCommand?: boolean;
    reason?: string;
  };
  sourceRenderer: Record<string, unknown>;
}

export interface PresentationBridgeBackend {
  startConversion(request: StartConversionRequest): { jobId: string };
  getJob(jobId: string): ApplicationJobSnapshot | undefined;
  hasActiveJobs(): boolean;
  waitForJob(jobId: string): Promise<ApplicationJobSnapshot>;
  cancel(jobId: string): boolean;
  listHistory(limit?: number): Promise<JobHistoryItem[]>;
  authorizeGoogle(): Promise<void>;
  doctor(): Promise<BridgeDoctorResult>;
  onProgress(listener: (event: ConversionProgressEvent) => void): () => void;
}
