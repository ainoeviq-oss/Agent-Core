import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPackage } from '@electron/asar';

const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as {
  author?: string;
  repository?: { type?: string; url?: string; directory?: string };
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  build?: {
    win?: { artifactName?: string };
    nsis?: { artifactName?: string };
    portable?: { artifactName?: string };
  };
};

test('Windows packaging uses distinct offline installer and portable artifact contracts', () => {
  assert.equal(packageJson.author, 'Presentation Bridge Contributors');
  assert.deepEqual(packageJson.repository, {
    type: 'git',
    url: 'git+https://github.com/rendevouz999/Agent-Core.git',
    directory: 'SubProject/Presentation-Bridge'
  });
  assert.equal(packageJson.devDependencies?.['@electron/asar'], '3.4.1');
  assert.equal(packageJson.build?.win?.artifactName, undefined);
  assert.equal(packageJson.build?.nsis?.artifactName, 'Presentation-Bridge-Setup-${version}-${arch}.${ext}');
  assert.equal(packageJson.build?.portable?.artifactName, 'Presentation-Bridge-Portable-${version}-${arch}.${ext}');
  assert.equal(packageJson.scripts?.['verify:release'], 'node ./scripts/verify-release.mjs');
  assert.match(packageJson.scripts?.['package:win'] ?? '', /--publish never/);
  assert.match(packageJson.scripts?.['package:win'] ?? '', /npm run verify:release/);
});

test('release verifier proves artifact identity, ASAR contents, and pending external gates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pb-release-contract-'));
  const appRoot = join(root, 'app');
  const releaseRoot = join(root, 'release');
  const unpackedRoot = join(releaseRoot, 'win-unpacked');
  const resourcesRoot = join(unpackedRoot, 'resources');

  for (const directory of [
    join(appRoot, 'dist', 'desktop'),
    join(appRoot, 'dist', 'ui'),
    join(appRoot, 'dist', 'src', 'cli'),
    resourcesRoot
  ]) {
    await mkdir(directory, { recursive: true });
  }

  await writeFile(join(appRoot, 'dist', 'desktop', 'main.js'), 'export {};\n');
  await writeFile(join(appRoot, 'dist', 'desktop', 'preload.cjs'), 'module.exports = {};\n');
  await writeFile(join(appRoot, 'dist', 'ui', 'index.html'), '<!doctype html>\n');
  await writeFile(join(appRoot, 'dist', 'src', 'cli', 'index.js'), 'export {};\n');
  await writeFile(join(appRoot, 'package.json'), '{"name":"presentation-bridge","version":"0.2.0"}\n');
  await createPackage(appRoot, join(resourcesRoot, 'app.asar'));

  const bytes = Buffer.alloc(64, 7);
  await writeFile(join(releaseRoot, 'Presentation-Bridge-Setup-0.2.0-x64.exe'), bytes);
  await writeFile(join(releaseRoot, 'Presentation-Bridge-Portable-0.2.0-x64.exe'), bytes);
  await writeFile(join(unpackedRoot, 'Presentation Bridge.exe'), bytes);

  const result = spawnSync(process.execPath, [resolve('scripts/verify-release.mjs')], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      PB_RELEASE_ROOT: releaseRoot,
      PB_RELEASE_MIN_EXE_BYTES: '1',
      PB_RELEASE_MIN_ASAR_BYTES: '1'
    },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const manifest = JSON.parse(await readFile(join(releaseRoot, 'release-manifest.json'), 'utf8')) as {
    version?: string;
    unsigned?: boolean;
    artifacts?: Array<{ role?: string; filename?: string; sha256?: string }>;
    packagedApp?: { requiredPathsPresent?: boolean; forbiddenPathsAbsent?: boolean };
    externalAcceptanceGates?: Record<string, boolean>;
  };
  assert.equal(manifest.version, '0.2.0');
  assert.equal(manifest.unsigned, true);
  assert.deepEqual(
    manifest.artifacts?.map((artifact) => [artifact.role, artifact.filename]),
    [
      ['installer', 'Presentation-Bridge-Setup-0.2.0-x64.exe'],
      ['portable', 'Presentation-Bridge-Portable-0.2.0-x64.exe'],
      ['unpackedExecutable', 'Presentation Bridge.exe'],
      ['asar', 'app.asar']
    ]
  );
  assert.ok(manifest.artifacts?.every((artifact) => /^[a-f0-9]{64}$/.test(artifact.sha256 ?? '')));
  assert.equal(manifest.packagedApp?.requiredPathsPresent, true);
  assert.equal(manifest.packagedApp?.forbiddenPathsAbsent, true);
  assert.deepEqual(manifest.externalAcceptanceGates, {
    windowsHostSmokePending: true,
    googleLivePending: true,
    keynoteLivePending: true
  });
});
