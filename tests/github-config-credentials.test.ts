import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { GitHubCredentialProvider } from '../src/github/credentials.js';

const roots: string[] = [];
const GH = 'SENTINEL_GH_TOKEN_DO_NOT_LEAK';
const PACKAGES = 'SENTINEL_PACKAGES_TOKEN_DO_NOT_LEAK';

async function tempRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-core-github-credentials-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('GitHubCredentialProvider', () => {
  it('reports configured paths without reading token contents', async () => {
    const root = await tempRoot();
    const config = loadConfig({}, root).github;
    await mkdir(config.tokenFile, { recursive: true });
    await mkdir(config.packagesTokenFile, { recursive: true });

    const provider = new GitHubCredentialProvider(config);
    await expect(provider.status()).resolves.toEqual({
      githubTokenConfigured: true,
      packagesTokenConfigured: true,
      githubTokenPath: config.tokenFile,
      packagesTokenPath: config.packagesTokenFile,
    });
  });

  it('reads each credential lazily and trims surrounding whitespace only', async () => {
    const root = await tempRoot();
    const config = loadConfig({}, root).github;
    await mkdir(path.dirname(config.tokenFile), { recursive: true });
    await writeFile(config.tokenFile, `  ${GH}\r\n`, 'utf8');
    await writeFile(config.packagesTokenFile, `\n${PACKAGES}  `, 'utf8');

    const provider = new GitHubCredentialProvider(config);
    await expect(provider.read('github')).resolves.toBe(GH);
    await expect(provider.read('packages')).resolves.toBe(PACKAGES);
  });

  it('returns safe public status with no token-derived metadata', async () => {
    const root = await tempRoot();
    const config = loadConfig({}, root).github;
    await mkdir(path.dirname(config.tokenFile), { recursive: true });
    await writeFile(config.tokenFile, GH, 'utf8');
    await writeFile(config.packagesTokenFile, PACKAGES, 'utf8');

    const provider = new GitHubCredentialProvider(config);
    const status = await provider.status();
    expect(Object.keys(status).sort()).toEqual([
      'githubTokenConfigured',
      'githubTokenPath',
      'packagesTokenConfigured',
      'packagesTokenPath',
    ]);
    expect(JSON.stringify(status)).not.toContain(GH);
    expect(JSON.stringify(status)).not.toContain(PACKAGES);
  });

  it('classifies a missing credential without exposing credential data', async () => {
    const root = await tempRoot();
    const provider = new GitHubCredentialProvider(loadConfig({}, root).github);

    await expect(provider.read('github')).rejects.toMatchObject({
      code: 'GITHUB_CREDENTIAL_MISSING',
    });
  });

  it('rejects whitespace-only credentials', async () => {
    const root = await tempRoot();
    const config = loadConfig({}, root).github;
    await mkdir(path.dirname(config.tokenFile), { recursive: true });
    await writeFile(config.tokenFile, ' \r\n\t ', 'utf8');

    const provider = new GitHubCredentialProvider(config);
    await expect(provider.read('github')).rejects.toMatchObject({
      code: 'GITHUB_CREDENTIAL_EMPTY',
    });
  });

  it('redacts exact loaded secrets from internal error text', async () => {
    const root = await tempRoot();
    const provider = new GitHubCredentialProvider(loadConfig({}, root).github);
    const redacted = provider.redact(`before ${GH} middle ${PACKAGES} after`, [GH, PACKAGES]);
    expect(redacted).toBe('before [REDACTED_GITHUB_CREDENTIAL] middle [REDACTED_GITHUB_CREDENTIAL] after');
    expect(redacted).not.toContain(GH);
    expect(redacted).not.toContain(PACKAGES);
  });
});
