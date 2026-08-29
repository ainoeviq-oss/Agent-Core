import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { listPackage } = require('@electron/asar');

const projectRoot = resolve(new URL('..', import.meta.url).pathname);
const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
const version = String(packageJson.version ?? '').trim();
if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) {
  throw new Error(`Invalid package version for release verification: ${version || '<missing>'}`);
}

const releaseRoot = resolve(process.env.PB_RELEASE_ROOT?.trim() || join(projectRoot, 'release'));
const minExeBytes = positiveInteger(process.env.PB_RELEASE_MIN_EXE_BYTES, 10 * 1024 * 1024, 'PB_RELEASE_MIN_EXE_BYTES');
const minAsarBytes = positiveInteger(process.env.PB_RELEASE_MIN_ASAR_BYTES, 100 * 1024, 'PB_RELEASE_MIN_ASAR_BYTES');
const filenames = {
  installer: `Presentation-Bridge-Setup-${version}-x64.exe`,
  portable: `Presentation-Bridge-Portable-${version}-x64.exe`,
  unpackedExecutable: 'Presentation Bridge.exe',
  asar: 'app.asar'
};
const paths = {
  installer: join(releaseRoot, filenames.installer),
  portable: join(releaseRoot, filenames.portable),
  unpackedExecutable: join(releaseRoot, 'win-unpacked', filenames.unpackedExecutable),
  asar: join(releaseRoot, 'win-unpacked', 'resources', filenames.asar)
};

if (new Set(Object.values(filenames)).size !== Object.values(filenames).length) {
  throw new Error('Windows release artifact filenames must be distinct.');
}
await assertMissing(join(releaseRoot, `Presentation-Bridge-${version}-x64.exe`), 'legacy colliding Windows artifact');

const artifacts = [];
for (const role of ['installer', 'portable', 'unpackedExecutable', 'asar']) {
  const minimum = role === 'asar' ? minAsarBytes : minExeBytes;
  const details = await inspectFile(paths[role], minimum, role);
  artifacts.push({ role, filename: filenames[role], ...details });
}

const packagedPaths = listPackage(paths.asar);
const packagedSet = new Set(packagedPaths);
const requiredPaths = [
  '/dist/desktop/main.js',
  '/dist/desktop/preload.cjs',
  '/dist/ui/index.html',
  '/dist/src/cli/index.js',
  '/package.json'
];
const forbiddenPrefixes = [
  '/dist/tests',
  '/dist/scripts',
  '/tests',
  '/src',
  '/secrets',
  '/runtime'
];
const missingRequiredPaths = requiredPaths.filter((entry) => !packagedSet.has(entry));
const forbiddenPaths = packagedPaths.filter((entry) => forbiddenPrefixes.some(
  (prefix) => entry === prefix || entry.startsWith(`${prefix}/`)
));
if (missingRequiredPaths.length > 0) {
  throw new Error(`Packaged ASAR is missing required paths: ${missingRequiredPaths.join(', ')}`);
}
if (forbiddenPaths.length > 0) {
  throw new Error(`Packaged ASAR contains forbidden paths: ${forbiddenPaths.slice(0, 20).join(', ')}`);
}

const manifest = {
  schemaVersion: 1,
  product: 'Presentation Bridge',
  version,
  platform: 'win32',
  arch: 'x64',
  unsigned: process.env.PB_RELEASE_SIGNED !== '1',
  generatedAt: new Date().toISOString(),
  artifacts,
  packagedApp: {
    asarFileCount: packagedPaths.length,
    requiredPaths,
    missingRequiredPaths,
    forbiddenPrefixes,
    forbiddenPaths,
    requiredPathsPresent: missingRequiredPaths.length === 0,
    forbiddenPathsAbsent: forbiddenPaths.length === 0,
    googleOAuthClientBundled: packagedSet.has('/dist/config/google-oauth-client.json')
  },
  externalAcceptanceGates: {
    windowsHostSmokePending: process.env.PB_WINDOWS_HOST_SMOKE_VERIFIED !== '1',
    googleLivePending: process.env.PB_GOOGLE_LIVE_VERIFIED !== '1',
    keynoteLivePending: process.env.PB_KEYNOTE_LIVE_VERIFIED !== '1'
  }
};

const manifestPath = join(releaseRoot, 'release-manifest.json');
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
console.log(JSON.stringify({
  ok: true,
  version,
  releaseRoot,
  manifest: basename(manifestPath),
  artifacts: artifacts.map(({ role, filename, bytes, sha256 }) => ({ role, filename, bytes, sha256 })),
  packagedApp: manifest.packagedApp,
  externalAcceptanceGates: manifest.externalAcceptanceGates
}, null, 2));

function positiveInteger(raw, fallback, name) {
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

async function assertMissing(path, label) {
  try {
    await access(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`${label} must not exist: ${path}`);
}

async function inspectFile(path, minimumBytes, label) {
  const details = await stat(path);
  if (!details.isFile()) throw new Error(`${label} is not a regular file: ${path}`);
  if (details.size < minimumBytes) {
    throw new Error(`${label} is too small (${details.size} bytes; expected at least ${minimumBytes}): ${path}`);
  }
  return { bytes: details.size, sha256: await sha256File(path) };
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
