import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverAnchorBackend, type GhRunner } from '../src/codespace/anchor-discovery.js';
import { localAnchorTarget, readAnchorTarget, writeAnchorTargetAtomic, type AnchorBackendTarget } from '../src/codespace/anchor-target.js';

const roots: string[] = [];
const anchorName = 'ominous-xylophone-69xxp4v76vv93xq64';

async function tempStatePath(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-core-anchor-discovery-'));
  roots.push(root);
  return path.join(root, 'anchor', 'backend.json');
}

function ghFixture(codespaces: Array<Record<string, unknown>>, ports: Record<string, Array<Record<string, unknown>>>): GhRunner {
  return async (args) => {
    if (args[0] === 'codespace' && args[1] === 'list') return JSON.stringify(codespaces);
    if (args[0] === 'codespace' && args[1] === 'ports') {
      const name = args[args.indexOf('-c') + 1] ?? '';
      return JSON.stringify(ports[name] ?? []);
    }
    throw new Error(`unexpected gh args: ${args.join(' ')}`);
  };
}

function verified(name: string): AnchorBackendTarget {
  const base = `https://${name}-8765.app.github.dev`;
  return { mode: 'remote', baseUrl: base, advertisedBaseUrl: base, codespaceName: name, verified: true, verifiedAt: '2026-08-27T00:00:00.000Z' };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Codespace anchor backend discovery', () => {
  it('keeps local fallback when there are no replacement Codespaces', async () => {
    const statePath = await tempStatePath();
    const result = await discoverAnchorBackend({
      statePath,
      anchorName,
      repository: 'ainoeviq-oss/Agent-Core',
      ghRunner: ghFixture([{ name: anchorName, repository: 'ainoeviq-oss/Agent-Core', state: 'Available' }], {}),
      verify: async () => { throw new Error('should_not_verify'); },
    });
    expect(result.status).toBe('local');
    expect(await readAnchorTarget(statePath)).toEqual(localAnchorTarget());
  });

  it('selects exactly one healthy replacement Codespace', async () => {
    const statePath = await tempStatePath();
    const candidate = 'new-backend-abc';
    const candidateUrl = `https://${candidate}-8765.app.github.dev`;
    const result = await discoverAnchorBackend({
      statePath,
      anchorName,
      repository: 'ainoeviq-oss/Agent-Core',
      ghRunner: ghFixture([
        { name: anchorName, repository: 'ainoeviq-oss/Agent-Core', state: 'Available' },
        { name: candidate, repository: 'ainoeviq-oss/Agent-Core', state: 'Available' },
      ], { [candidate]: [{ sourcePort: 8765, visibility: 'public', browseUrl: candidateUrl }] }),
      verify: async (url) => {
        expect(url).toBe(candidateUrl);
        return verified(candidate);
      },
    });
    expect(result.status).toBe('remote');
    expect((await readAnchorTarget(statePath)).baseUrl).toBe(candidateUrl);
  });

  it('fails closed and preserves the active target when multiple healthy replacements exist', async () => {
    const statePath = await tempStatePath();
    const existing = verified('existing-backend');
    await writeAnchorTargetAtomic(existing, statePath);
    const one = 'backend-one';
    const two = 'backend-two';
    await expect(discoverAnchorBackend({
      statePath,
      anchorName,
      repository: 'ainoeviq-oss/Agent-Core',
      ghRunner: ghFixture([
        { name: one, repository: 'ainoeviq-oss/Agent-Core', state: 'Available' },
        { name: two, repository: 'ainoeviq-oss/Agent-Core', state: 'Available' },
      ], {
        [one]: [{ sourcePort: 8765, visibility: 'public', browseUrl: `https://${one}-8765.app.github.dev` }],
        [two]: [{ sourcePort: 8765, visibility: 'public', browseUrl: `https://${two}-8765.app.github.dev` }],
      }),
      verify: async (url) => verified(new URL(url).hostname.replace(/-8765\.app\.github\.dev$/, '')),
    })).rejects.toThrow('ANCHOR_DISCOVERY_AMBIGUOUS');
    expect(await readAnchorTarget(statePath)).toEqual(existing);
  });

  it('ignores stopped, wrong-repository, anchor, and missing-port candidates', async () => {
    const statePath = await tempStatePath();
    const good = 'good-backend';
    const result = await discoverAnchorBackend({
      statePath,
      anchorName,
      repository: 'ainoeviq-oss/Agent-Core',
      ghRunner: ghFixture([
        { name: anchorName, repository: 'ainoeviq-oss/Agent-Core', state: 'Available' },
        { name: 'stopped', repository: 'ainoeviq-oss/Agent-Core', state: 'Shutdown' },
        { name: 'wrong-repo', repository: 'other/Agent-Core', state: 'Available' },
        { name: 'missing-port', repository: 'ainoeviq-oss/Agent-Core', state: 'Available' },
        { name: good, repository: 'ainoeviq-oss/Agent-Core', state: 'Available' },
      ], {
        'missing-port': [{ sourcePort: 3000, visibility: 'public', browseUrl: 'https://missing-port-3000.app.github.dev' }],
        [good]: [{ sourcePort: 8765, visibility: 'public', browseUrl: `https://${good}-8765.app.github.dev` }],
      }),
      verify: async () => verified(good),
    });
    expect(result.status).toBe('remote');
    expect((await readAnchorTarget(statePath)).codespaceName).toBe(good);
  });

  it('treats an unverifiable single candidate as no healthy replacement and returns local fallback', async () => {
    const statePath = await tempStatePath();
    const candidate = 'booting-backend';
    const result = await discoverAnchorBackend({
      statePath,
      anchorName,
      repository: 'ainoeviq-oss/Agent-Core',
      ghRunner: ghFixture([{ name: candidate, repository: 'ainoeviq-oss/Agent-Core', state: 'Available' }], {
        [candidate]: [{ sourcePort: 8765, visibility: 'public', browseUrl: `https://${candidate}-8765.app.github.dev` }],
      }),
      verify: async () => { throw new Error('not_ready'); },
    });
    expect(result.status).toBe('local');
    expect(await readAnchorTarget(statePath)).toEqual(localAnchorTarget());
  });
});
