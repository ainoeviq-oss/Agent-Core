import type { ConversionProgressEvent } from '../types/contracts.js';
import type { KeynoteWorkerSettingsInput, KeynoteWorkerSettingsView } from './settings-store.js';
import type {
  ApplicationJobSnapshot,
  BridgeDoctorResult,
  JobHistoryItem,
  StartConversionRequest
} from './contracts.js';

export interface SelectedPresentationFile {
  path: string;
  name: string;
  bytes: number;
}

export interface DesktopEnvironment {
  surface: 'desktop';
  version: string;
  platform: string;
  packaged: boolean;
}

export interface PresentationBridgeDesktopApi {
  environment(): Promise<DesktopEnvironment>;
  selectPresentation(): Promise<SelectedPresentationFile | null>;
  selectOutputDirectory(): Promise<string | null>;
  startConversion(request: StartConversionRequest): Promise<{ jobId: string }>;
  cancel(jobId: string): Promise<boolean>;
  getJob(jobId: string): Promise<ApplicationJobSnapshot | null>;
  listHistory(): Promise<JobHistoryItem[]>;
  doctor(): Promise<BridgeDoctorResult>;
  getKeynoteWorkerSettings(): Promise<KeynoteWorkerSettingsView>;
  saveKeynoteWorkerSettings(input: KeynoteWorkerSettingsInput): Promise<KeynoteWorkerSettingsView>;
  authorizeGoogle(): Promise<{ authorized: true }>;
  openPath(path: string): Promise<{ opened: true }>;
  revealPath(path: string): Promise<{ revealed: true }>;
  openExternal(url: string): Promise<{ opened: true }>;
  onProgress(listener: (event: ConversionProgressEvent) => void): () => void;
}
