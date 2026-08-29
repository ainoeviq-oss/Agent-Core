import type { BridgeConfig } from '../../config/index.js';
import type { SourceManifest, TargetResult } from '../../types/contracts.js';
import { keynoteDoctor } from '../../workers/keynote/doctor.js';
import { convertWithLocalKeynote, mockKeynoteResult } from '../../workers/keynote/local.js';
import { RemoteKeynoteWorker, remoteKeynoteDoctor, type RemoteKeynoteDoctorResult } from './remote.js';

export interface KeynoteConversionOptions {
  outputDir: string;
  mode: 'live' | 'mock';
  exportPdfPreview?: boolean;
}

export type KeynoteTargetDoctorResult = Awaited<ReturnType<typeof keynoteDoctor>> & { worker?: 'local' }
  | RemoteKeynoteDoctorResult;

export async function keynoteTargetDoctor(config: BridgeConfig): Promise<KeynoteTargetDoctorResult> {
  if (config.keynoteWorker === 'local') {
    return { ...(await keynoteDoctor()), worker: 'local' };
  }
  if (!config.keynoteRemoteUrl || !config.keynoteRemoteToken) {
    return {
      worker: 'remote',
      baseUrl: config.keynoteRemoteUrl ?? '',
      available: false,
      reason: 'Remote Keynote worker URL and authentication token are not configured.'
    };
  }
  return await remoteKeynoteDoctor({
    baseUrl: config.keynoteRemoteUrl,
    token: config.keynoteRemoteToken,
    ...(config.keynoteRemoteAllowInsecureLoopback ? { allowInsecureLoopback: true } : {})
  });
}

export async function convertToKeynote(
  sourcePath: string,
  manifest: SourceManifest,
  options: KeynoteConversionOptions,
  config: BridgeConfig
): Promise<TargetResult> {
  if (options.mode === 'mock') return mockKeynoteResult(manifest);
  if (config.keynoteWorker === 'remote') {
    if (!config.keynoteRemoteUrl || !config.keynoteRemoteToken) {
      return {
        target: 'keynote',
        status: 'unavailable',
        native: false,
        verification: 'unavailable',
        warnings: [],
        error: {
          code: 'KEYNOTE_WORKER_UNAVAILABLE',
          message: 'Remote Keynote worker URL and authentication token are not configured.'
        },
        metadata: { remote: true }
      };
    }
    return await new RemoteKeynoteWorker({
      baseUrl: config.keynoteRemoteUrl,
      token: config.keynoteRemoteToken,
      ...(config.keynoteRemoteAllowInsecureLoopback ? { allowInsecureLoopback: true } : {})
    }).convert(sourcePath, manifest, { outputDir: options.outputDir });
  }
  return await convertWithLocalKeynote(sourcePath, manifest, {
    outputDir: options.outputDir,
    ...(options.exportPdfPreview !== undefined ? { exportPdfPreview: options.exportPdfPreview } : {})
  });
}
