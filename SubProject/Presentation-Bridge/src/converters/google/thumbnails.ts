import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GoogleRestClient } from './rest.js';

export async function downloadGoogleThumbnails(client: GoogleRestClient, presentationId: string, outputDir: string): Promise<string[]> {
  await mkdir(outputDir, { recursive: true });
  const presentation = await client.getPresentation(presentationId);
  const outputs: string[] = [];
  const slides = presentation.slides ?? [];
  for (let index = 0; index < slides.length; index += 1) {
    const objectId = (slides[index] as { objectId?: string } | undefined)?.objectId;
    if (!objectId) continue;
    const thumb = await client.getThumbnail(presentationId, objectId);
    if (!thumb.contentUrl) continue;
    const response = await fetch(thumb.contentUrl);
    if (!response.ok) throw new Error(`Google thumbnail download failed for slide ${index + 1}: HTTP ${response.status}`);
    const path = join(outputDir, `slide-${String(index + 1).padStart(3, '0')}.png`);
    await writeFile(path, Buffer.from(await response.arrayBuffer()));
    outputs.push(path);
  }
  return outputs;
}
