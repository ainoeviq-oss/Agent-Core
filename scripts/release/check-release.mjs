import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..', '..');
const readText = (file) => readFile(path.join(root, file), 'utf8');
const parseJson = async (file) => JSON.parse(await readText(file));

function fail(message) {
  process.stderr.write(`release check failed: ${message}\n`);
  process.exit(1);
}

const [pkg, lock, serverSource, readme, changelog] = await Promise.all([
  parseJson('package.json'),
  parseJson('package-lock.json'),
  readText('src/mcp/server.ts'),
  readText('README.md'),
  readText('CHANGELOG.md'),
]);

const version = String(pkg.version ?? '').trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`package.json version is not stable semver: ${version || '<empty>'}`);
if (lock.version !== version || lock.packages?.['']?.version !== version) {
  fail(`package-lock.json version does not match package.json (${version})`);
}

const serverMatch = serverSource.match(/SERVER_VERSION\s*=\s*['"](\d+\.\d+\.\d+)['"]/);
if (!serverMatch) fail('could not locate SERVER_VERSION in src/mcp/server.ts');
if (serverMatch[1] !== version) fail(`SERVER_VERSION ${serverMatch[1]} does not match package version ${version}`);

if (!changelog.includes(`## [${version}]`)) fail(`CHANGELOG.md has no section for ${version}`);
if (/Agent Core\s+v?\d+\.\d+(?:\.\d+)?/i.test(readme) || readme.includes(`v${version}`)) {
  fail('README.md must stay Agent-Core-version neutral');
}

const tracked = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
  .map((item) => item.replaceAll('\\', '/'));

const historicalDocs = tracked.filter((file) => file.startsWith('docs/superpowers/'));
if (historicalDocs.length) fail(`historical docs/superpowers files remain tracked (${historicalDocs.length})`);

const forbiddenTracked = tracked.filter((file) =>
  file.startsWith('runtime/') ||
  file.startsWith('secrets/') ||
  file.startsWith('capabilities/') ||
  file.startsWith('node_modules/') ||
  file.startsWith('release/') ||
  file === '.env',
);
if (forbiddenTracked.length) fail(`forbidden release/runtime paths are tracked: ${forbiddenTracked.join(', ')}`);

process.stdout.write(JSON.stringify({
  ok: true,
  version,
  trackedFiles: tracked.length,
  serverVersion: serverMatch[1],
  changelogSection: true,
  readmeVersionNeutral: true,
  historicalScratchDocsTracked: 0,
}, null, 2) + '\n');
