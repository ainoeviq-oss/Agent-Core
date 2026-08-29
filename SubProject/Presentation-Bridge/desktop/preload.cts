import { contextBridge, ipcRenderer } from 'electron';
import type { PresentationBridgeDesktopApi } from '#core/application/desktop-contracts.js';
import type { ConversionProgressEvent } from '#core/types/contracts.js';

const api: PresentationBridgeDesktopApi = {
  environment: async () => await ipcRenderer.invoke('pb:environment'),
  selectPresentation: async () => await ipcRenderer.invoke('pb:select-presentation'),
  selectOutputDirectory: async () => await ipcRenderer.invoke('pb:select-output-directory'),
  startConversion: async (request) => await ipcRenderer.invoke('pb:start-conversion', request),
  cancel: async (jobId) => await ipcRenderer.invoke('pb:cancel', jobId),
  getJob: async (jobId) => await ipcRenderer.invoke('pb:get-job', jobId),
  listHistory: async () => await ipcRenderer.invoke('pb:list-history'),
  doctor: async () => await ipcRenderer.invoke('pb:doctor'),
  getKeynoteWorkerSettings: async () => await ipcRenderer.invoke('pb:keynote-settings:get'),
  saveKeynoteWorkerSettings: async (input) => await ipcRenderer.invoke('pb:keynote-settings:save', input),
  authorizeGoogle: async () => await ipcRenderer.invoke('pb:google-authorize'),
  openPath: async (path) => await ipcRenderer.invoke('pb:open-path', path),
  revealPath: async (path) => await ipcRenderer.invoke('pb:reveal-path', path),
  openExternal: async (url) => await ipcRenderer.invoke('pb:open-external', url),
  onProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: ConversionProgressEvent) => listener(payload);
    ipcRenderer.on('pb:progress', handler);
    return () => ipcRenderer.removeListener('pb:progress', handler);
  }
};

contextBridge.exposeInMainWorld('presentationBridge', api);
