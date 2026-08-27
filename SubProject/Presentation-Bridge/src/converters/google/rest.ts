import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { BridgeConfig } from '../../config/index.js';
import { BridgeError, ErrorCode } from '../../security/errors.js';
import { getGoogleAccessToken } from './oauth.js';
import { GOOGLE_SLIDES_MIME, PPTX_MIME } from './constants.js';

export interface GoogleDriveFile {
  id?: string;
  name?: string;
  mimeType?: string;
  webViewLink?: string;
  createdTime?: string;
}

export interface GoogleSlidesPresentation {
  presentationId?: string;
  title?: string;
  slides?: Array<Record<string, unknown>>;
  pageSize?: Record<string, unknown>;
}

async function parseResponse<T>(response: Response, code: typeof ErrorCode[keyof typeof ErrorCode]): Promise<T> {
  const text = await response.text();
  if (!response.ok) throw new BridgeError(code, `Google API request failed: HTTP ${response.status}`, { body: text.slice(0, 1000) });
  return text ? JSON.parse(text) as T : {} as T;
}

export class GoogleRestClient {
  constructor(private readonly config: BridgeConfig) {}

  private async headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    return { authorization: `Bearer ${await getGoogleAccessToken(this.config)}`, ...extra };
  }

  async aboutImportFormats(): Promise<{ importFormats?: Record<string, string[]>; maxImportSizes?: Record<string, string> }> {
    const url = new URL('https://www.googleapis.com/drive/v3/about');
    url.searchParams.set('fields', 'importFormats,maxImportSizes');
    return await parseResponse(await fetch(url, { headers: await this.headers() }), ErrorCode.GOOGLE_IMPORT_UNAVAILABLE);
  }

  async createNativeSlidesFromPptx(sourcePath: string, name: string, folderId?: string): Promise<GoogleDriveFile> {
    const info = await stat(sourcePath);
    const startUrl = new URL('https://www.googleapis.com/upload/drive/v3/files');
    startUrl.searchParams.set('uploadType', 'resumable');
    startUrl.searchParams.set('fields', 'id,name,mimeType,webViewLink,createdTime');
    const metadata = { name, mimeType: GOOGLE_SLIDES_MIME, ...(folderId ? { parents: [folderId] } : {}) };
    const start = await fetch(startUrl, {
      method: 'POST',
      headers: await this.headers({
        'content-type': 'application/json; charset=utf-8',
        'x-upload-content-type': PPTX_MIME,
        'x-upload-content-length': String(info.size)
      }),
      body: JSON.stringify(metadata)
    });
    if (!start.ok) await parseResponse(start, ErrorCode.GOOGLE_UPLOAD_FAILED);
    const location = start.headers.get('location');
    if (!location) throw new BridgeError(ErrorCode.GOOGLE_UPLOAD_FAILED, 'Google resumable upload did not return a session Location header.');
    const body = Readable.toWeb(createReadStream(sourcePath)) as unknown as BodyInit;
    const upload = await fetch(location, {
      method: 'PUT',
      headers: { 'content-type': PPTX_MIME, 'content-length': String(info.size) },
      body,
      duplex: 'half'
    } as RequestInit & { duplex: 'half' });
    return await parseResponse<GoogleDriveFile>(upload, ErrorCode.GOOGLE_UPLOAD_FAILED);
  }

  async getPresentation(presentationId: string): Promise<GoogleSlidesPresentation> {
    return await parseResponse(await fetch(`https://slides.googleapis.com/v1/presentations/${encodeURIComponent(presentationId)}`, {
      headers: await this.headers()
    }), ErrorCode.GOOGLE_SLIDES_GET_FAILED);
  }

  async batchUpdate(presentationId: string, requests: unknown[]): Promise<Record<string, unknown>> {
    return await parseResponse(await fetch(`https://slides.googleapis.com/v1/presentations/${encodeURIComponent(presentationId)}:batchUpdate`, {
      method: 'POST',
      headers: await this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ requests })
    }), ErrorCode.GOOGLE_REPAIR_REJECTED);
  }

  async getThumbnail(presentationId: string, pageObjectId: string): Promise<{ contentUrl?: string }> {
    const url = new URL(`https://slides.googleapis.com/v1/presentations/${encodeURIComponent(presentationId)}/pages/${encodeURIComponent(pageObjectId)}/thumbnail`);
    url.searchParams.set('thumbnailProperties.mimeType', 'PNG');
    url.searchParams.set('thumbnailProperties.thumbnailSize', 'LARGE');
    return await parseResponse(await fetch(url, { headers: await this.headers() }), ErrorCode.FIDELITY_RENDER_FAILED);
  }
}
