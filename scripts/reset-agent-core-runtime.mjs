import { randomBytes, randomUUID, scrypt } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const prefix = 'agent_core_live_';

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const dataDir = path.resolve(arg('--data-dir'));
const secretFile = path.resolve(arg('--secret-file'));
const keyName = arg('--name', 'chatgpt').trim() || 'chatgpt';
if (!arg('--data-dir') || !arg('--secret-file')) {
  throw new Error('--data-dir and --secret-file are required');
}
const secret = `${prefix}${randomBytes(32).toString('base64url')}`;
const salt = randomBytes(16);
const derived = await scryptAsync(secret, salt, 64);
const record = {
  id: randomUUID(),
  name: keyName,
  createdAt: new Date().toISOString(),
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  salt: salt.toString('base64'),
  hash: Buffer.from(derived).toString('base64'),
};
const oauth = {
  version: 1,
  clients: [],
  codes: [],
  accessTokens: [],
  refreshTokens: [],
};
await mkdir(dataDir, { recursive: true });
await mkdir(path.dirname(secretFile), { recursive: true });
await Promise.all([
  writeFile(path.join(dataDir, 'keys.json'), `${JSON.stringify({ version: 1, keys: [record] }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }),
  writeFile(path.join(dataDir, 'oauth.json'), `${JSON.stringify(oauth, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }),
  writeFile(secretFile, `${secret}\n`, { encoding: 'utf8', mode: 0o600 }),
]);

process.stdout.write(`${JSON.stringify({
  status: 'ok',
  dataDir,
  secretFile,
  keyId: record.id,
  keyName: record.name,
}, null, 2)}\n`);
