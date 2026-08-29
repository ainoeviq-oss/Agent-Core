import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BridgeConfig } from '../config/index.js';
import { validateRemoteKeynoteWorkerUrl } from '../converters/keynote/remote.js';

export interface SettingsSecretCodec {
  encrypt(plainText: string): string;
  decrypt(cipherText: string): string;
}

export interface KeynoteWorkerSettingsInput {
  mode: 'local' | 'remote';
  url?: string;
  token?: string;
}

export interface KeynoteWorkerSettingsView {
  mode: 'local' | 'remote';
  url: string;
  tokenConfigured: boolean;
}

interface StoredDesktopSettings {
  schemaVersion: 1;
  keynote: {
    mode: 'local' | 'remote';
    url?: string;
    tokenCiphertext?: string;
  };
}

function cleanBaseConfig(config: BridgeConfig): BridgeConfig {
  const {
    keynoteRemoteUrl: _keynoteRemoteUrl,
    keynoteRemoteToken: _keynoteRemoteToken,
    keynoteRemoteAllowInsecureLoopback: _allowInsecure,
    ...rest
  } = config;
  return rest;
}

export class DesktopSettingsStore {
  constructor(
    private readonly path: string,
    private readonly secrets: SettingsSecretCodec
  ) {}

  private async loadRecord(): Promise<StoredDesktopSettings | null> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Partial<StoredDesktopSettings>;
      if (parsed.schemaVersion !== 1 || !parsed.keynote || (parsed.keynote.mode !== 'local' && parsed.keynote.mode !== 'remote')) return null;
      return parsed as StoredDesktopSettings;
    } catch {
      return null;
    }
  }

  private async writeRecord(record: StoredDesktopSettings): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tempPath = `${this.path}.${process.pid}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(tempPath, this.path);
  }

  async view(fallback?: BridgeConfig): Promise<KeynoteWorkerSettingsView> {
    const record = await this.loadRecord();
    if (!record) {
      return {
        mode: fallback?.keynoteWorker ?? 'local',
        url: fallback?.keynoteRemoteUrl ?? '',
        tokenConfigured: Boolean(fallback?.keynoteRemoteToken)
      };
    }
    return {
      mode: record.keynote.mode,
      url: record.keynote.url ?? '',
      tokenConfigured: Boolean(record.keynote.tokenCiphertext)
    };
  }

  async saveKeynoteWorker(input: KeynoteWorkerSettingsInput): Promise<KeynoteWorkerSettingsView> {
    if (input.mode === 'local') {
      await this.writeRecord({ schemaVersion: 1, keynote: { mode: 'local' } });
      return { mode: 'local', url: '', tokenConfigured: false };
    }

    const url = input.url?.trim() ?? '';
    if (!url) throw new Error('Remote Keynote worker URL is required.');
    const validated = validateRemoteKeynoteWorkerUrl(url);
    const normalizedUrl = validated.toString().replace(/\/+$/, '');
    const existing = await this.loadRecord();
    const providedToken = input.token?.trim() ?? '';
    const existingCiphertext = existing?.keynote.mode === 'remote' ? existing.keynote.tokenCiphertext : undefined;
    const tokenCiphertext = providedToken ? this.secrets.encrypt(providedToken) : existingCiphertext;
    if (!tokenCiphertext) throw new Error('Remote Keynote worker authentication token is required.');

    await this.writeRecord({
      schemaVersion: 1,
      keynote: {
        mode: 'remote',
        url: normalizedUrl,
        tokenCiphertext
      }
    });
    return { mode: 'remote', url: normalizedUrl, tokenConfigured: true };
  }

  async applyToConfig(config: BridgeConfig): Promise<BridgeConfig> {
    const record = await this.loadRecord();
    if (!record) return config;
    const clean = cleanBaseConfig(config);
    if (record.keynote.mode === 'local') return { ...clean, keynoteWorker: 'local' };
    if (!record.keynote.url || !record.keynote.tokenCiphertext) {
      return { ...clean, keynoteWorker: 'remote' };
    }
    return {
      ...clean,
      keynoteWorker: 'remote',
      keynoteRemoteUrl: record.keynote.url,
      keynoteRemoteToken: this.secrets.decrypt(record.keynote.tokenCiphertext)
    };
  }
}
