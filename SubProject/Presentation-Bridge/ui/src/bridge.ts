import type { PresentationBridgeDesktopApi, SelectedPresentationFile } from '../../src/application/desktop-contracts.js';
import type { ApplicationJobSnapshot, BridgeDoctorResult, JobHistoryItem } from '../../src/application/contracts.js';
import type { ConversionProgressEvent, JobTarget } from '../../src/types/contracts.js';

export interface SelectedPresentation {
  name: string;
  bytes: number;
  path?: string;
  file?: File;
}

export interface UiStartConversion {
  source: SelectedPresentation;
  target: JobTarget;
  outputRoot?: string;
}

export interface UiBridge {
  surface: 'desktop' | 'hosted';
  selectPresentation(): Promise<SelectedPresentation | null>;
  selectOutputDirectory(): Promise<string | null>;
  startConversion(request: UiStartConversion): Promise<{ jobId: string }>;
  cancel(jobId: string): Promise<boolean>;
  getJob(jobId: string): Promise<ApplicationJobSnapshot | null>;
  listHistory(): Promise<JobHistoryItem[]>;
  doctor(): Promise<BridgeDoctorResult>;
  authorizeGoogle(): Promise<void>;
  openExternal(url: string): Promise<void>;
  openReport(item: JobHistoryItem | { jobId: string; htmlReportPath?: string }): Promise<void>;
  revealArtifact(path: string): Promise<void>;
  onProgress(listener: (event: ConversionProgressEvent) => void): () => void;
}

declare global {
  interface Window {
    presentationBridge?: PresentationBridgeDesktopApi;
  }
}

function desktopBridge(api: PresentationBridgeDesktopApi): UiBridge {
  return {
    surface: 'desktop',
    selectPresentation: async () => {
      const selected: SelectedPresentationFile | null = await api.selectPresentation();
      return selected ? { name: selected.name, bytes: selected.bytes, path: selected.path } : null;
    },
    selectOutputDirectory: async () => await api.selectOutputDirectory(),
    startConversion: async ({ source, target, outputRoot }) => {
      if (!source.path) throw new Error('Desktop source path is unavailable.');
      return await api.startConversion({ sourcePath: source.path, target, ...(outputRoot ? { outputRoot } : {}) });
    },
    cancel: async (jobId) => await api.cancel(jobId),
    getJob: async (jobId) => await api.getJob(jobId),
    listHistory: async () => await api.listHistory(),
    doctor: async () => await api.doctor(),
    authorizeGoogle: async () => { await api.authorizeGoogle(); },
    openExternal: async (url) => { await api.openExternal(url); },
    openReport: async (item) => {
      if (!item.htmlReportPath) throw new Error('HTML report is not available for this job.');
      await api.openPath(item.htmlReportPath);
    },
    revealArtifact: async (path) => { await api.revealPath(path); },
    onProgress: (listener) => api.onProgress(listener)
  };
}

function hostedBridge(): UiBridge {
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  const headers = (): HeadersInit => token ? { authorization: `Bearer ${token}` } : {};
  const withToken = (path: string): string => token
    ? `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
    : path;
  const apiFetch = async (path: string, init?: RequestInit): Promise<Response> => {
    const response = await fetch(path, {
      ...init,
      headers: { ...headers(), ...(init?.headers ?? {}) }
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: { message: `HTTP ${response.status}` } })) as { error?: { message?: string } };
      throw new Error(body.error?.message ?? `HTTP ${response.status}`);
    }
    return response;
  };

  return {
    surface: 'hosted',
    selectPresentation: async () => null,
    selectOutputDirectory: async () => null,
    startConversion: async ({ source, target }) => {
      if (!source.file) throw new Error('Browser source file is unavailable.');
      const response = await apiFetch(`/api/jobs?target=${encodeURIComponent(target)}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          'x-pb-filename': source.file.name
        },
        body: source.file
      });
      return await response.json() as { jobId: string };
    },
    cancel: async (jobId) => {
      const response = await apiFetch(`/api/jobs/${encodeURIComponent(jobId)}?action=cancel`, { method: 'POST' });
      return (await response.json() as { cancelled: boolean }).cancelled;
    },
    getJob: async (jobId) => {
      const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { headers: headers() });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json() as ApplicationJobSnapshot;
    },
    listHistory: async () => await (await apiFetch('/api/history')).json() as JobHistoryItem[],
    doctor: async () => await (await apiFetch('/api/doctor')).json() as BridgeDoctorResult,
    authorizeGoogle: async () => { await apiFetch('/api/google/authorize', { method: 'POST' }); },
    openExternal: async (url) => { window.open(url, '_blank', 'noopener,noreferrer'); },
    openReport: async (item) => { window.open(withToken(`/api/jobs/${encodeURIComponent(item.jobId)}/report.html`), '_blank', 'noopener,noreferrer'); },
    revealArtifact: async () => { throw new Error('Reveal in file manager is available in the desktop app.'); },
    onProgress: (listener) => {
      const controller = new AbortController();
      void (async () => {
        try {
          const response = await apiFetch('/api/events', { signal: controller.signal });
          const reader = response.body?.getReader();
          if (!reader) return;
          const decoder = new TextDecoder();
          let buffer = '';
          while (!controller.signal.aborted) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let boundary = buffer.indexOf('\n\n');
            while (boundary >= 0) {
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
              if (dataLine) listener(JSON.parse(dataLine.slice(6)) as ConversionProgressEvent);
              boundary = buffer.indexOf('\n\n');
            }
          }
        } catch (error) {
          if (!controller.signal.aborted) console.error('Hosted progress stream failed', error);
        }
      })();
      return () => controller.abort();
    }
  };
}

export const bridge: UiBridge = window.presentationBridge ? desktopBridge(window.presentationBridge) : hostedBridge();
