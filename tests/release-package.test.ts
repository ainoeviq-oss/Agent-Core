import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve('.');

async function loadContract(): Promise<any> {
  return import('../scripts/release/release-contract.mjs');
}

describe('stable release package contract', () => {
  it('names the Agent Core, plugin, Presentation Bridge, manifest, and checksum assets deterministically', async () => {
    const { releaseAssetNames } = await loadContract();
    expect(releaseAssetNames('0.5.4', '0.2.0')).toEqual({
      runtimeZip: 'agent-core-windows-v0.5.4-stable.zip',
      pluginZip: 'agent-core-plugin-v0.5.4-stable.zip',
      presentationBridgeZip: 'presentation-bridge-v0.2.0-source.zip',
      npmTarball: 'rendevouz999-agent-core-plugin-0.5.4.tgz',
      manifest: 'release-manifest.json',
      checksums: 'SHA256SUMS.txt',
    });
  });

  it('packages only tracked Presentation Bridge source and excludes runtime, credentials, generated output, and caches', async () => {
    const { isPresentationBridgeSourcePath } = await loadContract();
    const included = [
      'SubProject/Presentation-Bridge/README.md',
      'SubProject/Presentation-Bridge/package.json',
      'SubProject/Presentation-Bridge/src/index.ts',
      'SubProject/Presentation-Bridge/ui/src/App.tsx',
      'SubProject/Presentation-Bridge/tests/unit/simple-ui-contract.test.ts',
    ];
    const excluded = [
      'SubProject/Presentation-Bridge/runtime/.gitkeep',
      'SubProject/Presentation-Bridge/runtime/jobs/job.json',
      'SubProject/Presentation-Bridge/secrets/.gitkeep',
      'SubProject/Presentation-Bridge/secrets/google/client.json',
      'SubProject/Presentation-Bridge/node_modules/pkg/index.js',
      'SubProject/Presentation-Bridge/dist/index.js',
      'SubProject/Presentation-Bridge/release/app.exe',
      'SubProject/Presentation-Bridge/corpus/generated/sample.pptx',
      'SubProject/Other/file.txt',
    ];
    for (const candidate of included) expect(isPresentationBridgeSourcePath(candidate)).toBe(true);
    for (const candidate of excluded) expect(isPresentationBridgeSourcePath(candidate)).toBe(false);
  });

  it('keeps canonical Codespaces and Windows cutover documentation in the runtime package without secret-bearing roots', async () => {
    const { RUNTIME_RELEASE_ITEMS } = await loadContract();
    expect(RUNTIME_RELEASE_ITEMS).toContain('docs/codespaces.md');
    expect(RUNTIME_RELEASE_ITEMS).toContain('docs/windows-installation-cutover.md');
    expect(RUNTIME_RELEASE_ITEMS).not.toContain('secrets');
    expect(RUNTIME_RELEASE_ITEMS).not.toContain('runtime');
    expect(RUNTIME_RELEASE_ITEMS).not.toContain('capabilities');
    expect(RUNTIME_RELEASE_ITEMS).not.toContain('node_modules');
  });

  it('uses the cross-platform Node release builder and keeps the PowerShell entry point as a wrapper', async () => {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    const nodeBuilder = await readFile(path.join(root, 'scripts', 'release', 'build-release.mjs'), 'utf8');
    const powershellWrapper = await readFile(path.join(root, 'scripts', 'release', 'build-release.ps1'), 'utf8');
    expect(pkg.scripts?.['package:release']).toBe('node scripts/release/build-release.mjs');
    expect(pkg.scripts?.['build:codespace']).toBe('npm --prefix plugin/codespace ci && npm --prefix plugin/codespace run build');
    expect(pkg.scripts?.verify).toContain('npm run build:codespace');
    expect(pkg.scripts?.verify?.indexOf('npm run build:codespace')).toBeLessThan(pkg.scripts?.verify?.indexOf('npm test') ?? -1);
    expect(nodeBuilder).toContain('presentationBridgeSourcePackage');
    expect(nodeBuilder).toContain('releaseAssetNames');
    expect(nodeBuilder).not.toContain('gh-token.txt');
    expect(nodeBuilder).not.toContain('packages-token.txt');
    expect(powershellWrapper).toContain('build-release.mjs');
  });

  it('documents clone, zero-touch Codespaces, Presentation Bridge, Releases, and authenticated GitHub Packages usage', async () => {
    const readme = await readFile(path.join(root, 'README.md'), 'utf8');
    expect(readme).toContain('git clone https://github.com/rendevouz999/Agent-Core.git');
    expect(readme).toContain('test koneksi');
    expect(readme).toContain('## GitHub Codespaces');
    expect(readme).toContain('## Presentation Bridge');
    expect(readme).toContain('presentation-bridge-v0.2.0-source.zip');
    expect(readme).toContain('@rendevouz999/agent-core-plugin');
    expect(readme).toContain('https://npm.pkg.github.com');
    expect(readme).toContain('## Releases and packages');
  });
});
