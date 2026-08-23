import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const script = path.resolve('scripts/check-agent-core-brand.mjs');

async function fixture(text: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-core-brand-'));
  roots.push(root);
  await writeFile(path.join(root, 'sample.txt'), text, 'utf8');
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Agent Core brand scanner', () => {
  it('rejects legacy owned brand strings', async () => {
    const oldWord = ['Com', 'mander'].join('');
    const root = await fixture(`legacy Desktop ${oldWord} identity`);
    const run = spawnSync(process.execPath, [script, '--scan-path', root], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stdout + run.stderr).toContain('sample.txt');
  });

  it('accepts clean Agent Core text', async () => {
    const root = await fixture('Agent Core uses AGENT_CORE_PORT and agent_core_status.');
    const run = spawnSync(process.execPath, [script, '--scan-path', root], { encoding: 'utf8' });
    expect(run.status).toBe(0);
  });
});
