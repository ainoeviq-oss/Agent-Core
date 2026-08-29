import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const outputRoot = resolve(process.env.PB_DISTRIBUTION_CONFIG_ROOT ?? './dist/config');
const outputPath = resolve(outputRoot, 'google-oauth-client.json');
const clientId = process.env.PB_GOOGLE_CLIENT_ID?.trim() ?? '';
const clientSecret = process.env.PB_GOOGLE_CLIENT_SECRET?.trim() ?? '';

await mkdir(outputRoot, { recursive: true });
if (!clientId && !clientSecret) {
  await rm(outputPath, { force: true });
  console.log('[presentation-bridge] Google OAuth client omitted from distribution; set PB_GOOGLE_CLIENT_ID and PB_GOOGLE_CLIENT_SECRET at build time to provision it.');
  process.exit(0);
}
if (!clientId || !clientSecret) {
  throw new Error('PB_GOOGLE_CLIENT_ID and PB_GOOGLE_CLIENT_SECRET must be provided together.');
}

const payload = {
  installed: {
    client_id: clientId,
    client_secret: clientSecret,
    auth_uri: process.env.PB_GOOGLE_AUTH_URI?.trim() || 'https://accounts.google.com/o/oauth2/v2/auth',
    token_uri: process.env.PB_GOOGLE_TOKEN_URI?.trim() || 'https://oauth2.googleapis.com/token',
    redirect_uris: ['http://127.0.0.1']
  }
};
await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
console.log('[presentation-bridge] Google Desktop OAuth client provisioned into distribution config without source credential files.');
