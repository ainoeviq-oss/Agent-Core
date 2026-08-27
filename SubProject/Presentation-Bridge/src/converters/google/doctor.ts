import type { BridgeConfig } from '../../config/index.js';
import { serializeError } from '../../security/errors.js';
import { googleCredentialStatus, getGoogleAccessToken } from './oauth.js';
import { GoogleRestClient } from './rest.js';
import { verifyGoogleImportCapability } from './adapter.js';

export async function googleDoctor(config: BridgeConfig): Promise<Record<string, unknown>> {
  const files = await googleCredentialStatus(config);
  if (!files.tokenPresent) return { ...files, liveAuth: false, importCapability: false, reason: 'token-not-configured' };
  try {
    await getGoogleAccessToken(config);
    const client = new GoogleRestClient(config);
    await verifyGoogleImportCapability(client);
    return { ...files, liveAuth: true, importCapability: true };
  } catch (error) {
    return { ...files, liveAuth: false, importCapability: false, error: serializeError(error) };
  }
}
