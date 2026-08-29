import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RELEASE_EXCLUSIONS,
  RELEASE_FORMAT,
  RUNTIME_RELEASE_ITEMS,
  isPresentationBridgeSourcePath,
  normalizeArchivePath,
  releaseAssetNames,
} from './release-contract.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..', '..');
const args = parseArgs(process.argv.slice(2));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const presentationPkg = JSON.parse(await readFile(
  path.join(root, 'SubProject', 'Presentation-Bridge', 'package.json'),
  'utf8',
));
const version = stableVersion(pkg.version, 'Agent Core');
const presentationBridgeVersion = stableVersion(presentationPkg.version, 'Presentation Bridge');
const tag = `v${version}`;
const names = releaseAssetNames(version, presentationBridgeVersion);
const outputRoot = path.resolve(args.outputRoot || path.join(root, 'release'));
const releaseRoot = path.join(outputRoot, tag);
const assetsDir = path.join(releaseRoot, 'assets');
const stagingDir = path.join(releaseRoot, 'staging');
const pluginStage = path.join(stagingDir, 'agent-core-plugin');
const sourceCommit = git(['rev-parse', 'HEAD']);
const commitTimestamp = Number(git(['show', '-s', '--format=%ct', 'HEAD']));
const archiveDate = Number.isFinite(commitTimestamp) ? new Date(commitTimestamp * 1000) : new Date();

assertCleanTrackedTree();
await rm(releaseRoot, { recursive: true, force: true });
await mkdir(assetsDir, { recursive: true });

const runtimeEntries = await collectRuntimeEntries();
await writeStoredZip(path.join(assetsDir, names.runtimeZip), runtimeEntries, archiveDate);

await buildPluginStage();
const pluginEntries = await collectDirectoryEntries(pluginStage, 'agent-core-plugin');
await writeStoredZip(path.join(assetsDir, names.pluginZip), pluginEntries, archiveDate);

const presentationEntries = await collectPresentationBridgeEntries();
await writeStoredZip(path.join(assetsDir, names.presentationBridgeZip), presentationEntries, archiveDate);

const npm = npmInvocation();
const npmOutput = execFileSync(npm.executable, [...npm.prefix, 'pack', '--pack-destination', assetsDir], {
  cwd: pluginStage,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
}).trim().split(/\r?\n/).filter(Boolean).at(-1);
if (npmOutput !== names.npmTarball) {
  throw new Error(`Unexpected npm package filename: ${npmOutput || '<empty>'}; expected ${names.npmTarball}`);
}

const primaryAssets = [
  names.runtimeZip,
  names.pluginZip,
  names.presentationBridgeZip,
  names.npmTarball,
];
const manifestAssets = [];
for (const name of primaryAssets) {
  const file = path.join(assetsDir, name);
  const bytes = (await lstat(file)).size;
  manifestAssets.push({ name, bytes, sha256: await sha256File(file) });
}

const manifest = {
  format: RELEASE_FORMAT,
  version,
  tag,
  channel: 'stable',
  sourceCommit,
  generatedAt: new Date().toISOString(),
  runtimePackage: names.runtimeZip,
  pluginPackage: names.pluginZip,
  presentationBridgeVersion,
  presentationBridgeSourcePackage: names.presentationBridgeZip,
  githubPackage: '@rendevouz999/agent-core-plugin',
  packageDistTag: 'stable',
  exclusions: RELEASE_EXCLUSIONS,
  assets: manifestAssets,
};
const manifestPath = path.join(assetsDir, names.manifest);
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

const checksumAssets = [...primaryAssets, names.manifest];
const checksumLines = [];
for (const name of checksumAssets) {
  checksumLines.push(`${await sha256File(path.join(assetsDir, name))}  ${name}`);
}
const checksumPath = path.join(assetsDir, names.checksums);
await writeFile(checksumPath, `${checksumLines.join('\n')}\n`, { encoding: 'ascii', mode: 0o600 });
await chmod(manifestPath, 0o600).catch(() => undefined);
await chmod(checksumPath, 0o600).catch(() => undefined);

process.stdout.write(`${JSON.stringify({
  ok: true,
  version,
  tag,
  sourceCommit,
  presentationBridgeVersion,
  releaseRoot,
  assetsDir,
  pluginPublishDir: pluginStage,
  assets: [...primaryAssets, names.manifest, names.checksums],
  entryCounts: {
    runtime: runtimeEntries.length,
    plugin: pluginEntries.length,
    presentationBridge: presentationEntries.length,
  },
}, null, 2)}\n`);

function parseArgs(values) {
  const result = { outputRoot: '' };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--output-root') {
      result.outputRoot = values[index + 1] || '';
      index += 1;
      continue;
    }
    throw new Error(`Unknown release builder argument: ${value}`);
  }
  return result;
}

function stableVersion(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+\.\d+\.\d+$/.test(normalized)) {
    throw new Error(`${label} version is not stable semver: ${normalized || '<empty>'}`);
  }
  return normalized;
}

function git(arguments_) {
  return execFileSync('git', ['-C', root, ...arguments_], { encoding: 'utf8' }).trim();
}

function assertCleanTrackedTree() {
  const status = git(['status', '--porcelain=v1', '--untracked-files=no']);
  if (status) throw new Error(`Release packaging requires a clean tracked tree:\n${status}`);
}

function npmInvocation() {
  const npmExecPath = process.env.npm_execpath?.trim();
  if (npmExecPath && /npm-cli\.(?:c?js|mjs)$/i.test(npmExecPath)) {
    return { executable: process.execPath, prefix: [npmExecPath] };
  }
  if (process.platform === 'win32') {
    return {
      executable: process.execPath,
      prefix: [path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')],
    };
  }
  return { executable: 'npm', prefix: [] };
}

async function collectRuntimeEntries() {
  const entries = [];
  for (const item of RUNTIME_RELEASE_ITEMS) {
    const source = path.join(root, item);
    try {
      entries.push(...await collectPathEntries(source, normalizeArchivePath(path.join('Agent-Core', item))));
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error(`Release source missing: ${item}`);
      throw error;
    }
  }
  return uniqueSortedEntries(entries);
}

async function collectPresentationBridgeEntries() {
  const tracked = git(['ls-files', '-z', '--', 'SubProject/Presentation-Bridge'])
    .split('\0')
    .filter(Boolean)
    .map(normalizeArchivePath)
    .filter(isPresentationBridgeSourcePath)
    .sort();
  if (tracked.length === 0) throw new Error('No tracked Presentation Bridge source files were found');
  const entries = [];
  for (const trackedPath of tracked) {
    const relative = trackedPath.slice('SubProject/Presentation-Bridge/'.length);
    entries.push({
      name: normalizeArchivePath(path.join('Presentation-Bridge', relative)),
      data: await readFile(path.join(root, trackedPath)),
    });
  }
  return uniqueSortedEntries(entries);
}

async function buildPluginStage() {
  await rm(pluginStage, { recursive: true, force: true });
  await mkdir(path.join(pluginStage, 'skills', 'agent-core-capability-router'), { recursive: true });
  await mkdir(path.join(pluginStage, 'skills', 'agent-core-github'), { recursive: true });
  await Promise.all([
    cp(path.join(root, 'plugin', 'agent-core', 'README.md'), path.join(pluginStage, 'README.md')),
    cp(path.join(root, 'CHANGELOG.md'), path.join(pluginStage, 'CHANGELOG.md')),
    cp(
      path.join(root, 'plugin', 'agent-core', 'skills', 'agent-core-capability-router', 'SKILL.md'),
      path.join(pluginStage, 'skills', 'agent-core-capability-router', 'SKILL.md'),
    ),
    cp(
      path.join(root, 'plugin', 'agent-core', 'skills', 'agent-core-github', 'SKILL.md'),
      path.join(pluginStage, 'skills', 'agent-core-github', 'SKILL.md'),
    ),
  ]);
  const pluginMetadata = {
    format: 'agent-core-plugin-source-v1',
    name: 'Agent Core',
    version,
    channel: 'stable',
    description: 'Tracked Agent Core Capability Router and Native GitHub Fabric skills plus the existing Agent Core MCP app binding.',
    app: {
      name: 'Agent Core',
      protocol: 'mcp',
      endpoint: '/mcp',
      binding: 'existing-connected-chatgpt-app',
      discovery: 'tools/list',
    },
    skills: ['agent-core-capability-router', 'agent-core-github'],
    generatedFrom: {
      source: 'tracked-release-core',
      localAuditedRegistryVendored: false,
    },
  };
  const npmPackage = {
    name: '@rendevouz999/agent-core-plugin',
    version,
    description: 'Stable Agent Core routing and Native GitHub Fabric plugin source for the Agent Core MCP app.',
    private: false,
    license: 'UNLICENSED',
    files: ['README.md', 'CHANGELOG.md', 'agent-core-package.json', 'skills/**'],
    repository: {
      type: 'git',
      url: 'git+https://github.com/rendevouz999/Agent-Core.git',
    },
    publishConfig: {
      registry: 'https://npm.pkg.github.com',
    },
  };
  await Promise.all([
    writeFile(path.join(pluginStage, 'agent-core-package.json'), `${JSON.stringify(pluginMetadata, null, 2)}\n`, 'utf8'),
    writeFile(path.join(pluginStage, 'package.json'), `${JSON.stringify(npmPackage, null, 2)}\n`, 'utf8'),
  ]);
}

async function collectDirectoryEntries(directory, archiveRoot) {
  return uniqueSortedEntries(await collectPathEntries(directory, archiveRoot));
}

async function collectPathEntries(source, archivePath) {
  const details = await lstat(source);
  if (details.isSymbolicLink()) throw new Error(`Release packaging refuses symbolic links: ${source}`);
  if (details.isFile()) return [{ name: normalizeArchivePath(archivePath), data: await readFile(source) }];
  if (!details.isDirectory()) return [];
  const entries = [];
  for (const child of (await readdir(source)).sort()) {
    entries.push(...await collectPathEntries(path.join(source, child), path.join(archivePath, child)));
  }
  return entries;
}

function uniqueSortedEntries(entries) {
  const seen = new Set();
  return [...entries]
    .map((entry) => ({ ...entry, name: safeArchiveEntryName(entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name))
    .filter((entry) => {
      if (seen.has(entry.name)) throw new Error(`Duplicate release archive path: ${entry.name}`);
      seen.add(entry.name);
      return true;
    });
}

function safeArchiveEntryName(value) {
  const normalized = normalizeArchivePath(value);
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`Unsafe release archive path: ${value}`);
  }
  return normalized;
}

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(input) {
  const date = new Date(input);
  const year = Math.min(2107, Math.max(1980, date.getUTCFullYear()));
  const month = Math.min(12, Math.max(1, date.getUTCMonth() + 1));
  const day = Math.min(31, Math.max(1, date.getUTCDate()));
  const hours = Math.min(23, Math.max(0, date.getUTCHours()));
  const minutes = Math.min(59, Math.max(0, date.getUTCMinutes()));
  const seconds = Math.min(59, Math.max(0, date.getUTCSeconds()));
  return {
    date: ((year - 1980) << 9) | (month << 5) | day,
    time: (hours << 11) | (minutes << 5) | Math.floor(seconds / 2),
  };
}

async function writeStoredZip(file, entries, timestamp) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const dt = dosDateTime(timestamp);
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dt.time, 10);
    local.writeUInt16LE(dt.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dt.time, 12);
    central.writeUInt16LE(dt.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 * 0x10000) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const centralOffset = offset;
  const centralSize = centrals.reduce((sum, item) => sum + item.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  await writeFile(file, Buffer.concat([...locals, ...centrals, eocd]));
}
