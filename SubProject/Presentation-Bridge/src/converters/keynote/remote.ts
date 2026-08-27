import type { SourceManifest, TargetResult } from '../../types/contracts.js';
import { BridgeError, ErrorCode, serializeError } from '../../security/errors.js';

export interface RemoteKeynoteWorkerClient {
  convert(sourcePath: string, manifest: SourceManifest): Promise<TargetResult>;
}

export class UnconfiguredRemoteKeynoteWorker implements RemoteKeynoteWorkerClient {
  async convert(): Promise<TargetResult> {
    return {
      target: 'keynote',
      status: 'unavailable',
      native: false,
      verification: 'unavailable',
      warnings: [],
      error: serializeError(new BridgeError(ErrorCode.KEYNOTE_WORKER_UNAVAILABLE, 'Remote Keynote worker protocol is intentionally unconfigured in V1. Configure an authenticated Mac worker before selecting remote mode.')),
      metadata: {}
    };
  }
}
