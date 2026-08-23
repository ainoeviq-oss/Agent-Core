import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { FileKeyStore } from '../src/auth/key-store.js';

const roots: string[] = [];
async function temp(prefix: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Agent Core cutover utilities', () => {
  it('backs up owned state without printing secret contents', async () => {
    const source = await temp('agent-core-source-');
    const backup = await temp('agent-core-backup-');
    await mkdir(path.join(source, 'runtime', 'data'), { recursive: true });
    await mkdir(path.join(source, 'secrets'), { recursive: true });
    await writeFile(path.join(source, 'runtime', 'data', 'keys.json'), '{"version":1,"keys":[]}', 'utf8');
    await writeFile(path.join(source, 'secrets', 'private.txt'), 'TOP_SECRET_VALUE', 'utf8');
    const script = path.resolve('scripts/prepare-agent-core-cutover.ps1');
    const run = spawnSync('powershell.exe', ['-NoProfile', '-File', script, '-SourceRoot', source, '-BackupRoot', backup], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout + run.stderr).not.toContain('TOP_SECRET_VALUE');
    const backupPath = run.stdout.trim().split(/\r?\n/).at(-1)!;
    expect(await readFile(path.join(backupPath, 'secrets', 'private.txt'), 'utf8')).toBe('TOP_SECRET_VALUE');
    expect(await readFile(path.join(backupPath, 'migration-manifest.json'), 'utf8')).not.toContain('TOP_SECRET_VALUE');
  });

  it('resets active runtime with a fresh Agent Core key and empty OAuth state', async () => {
    const target = await temp('agent-core-reset-');
    const dataDir = path.join(target, 'runtime', 'data');
    const secretFile = path.join(target, 'secrets', 'agent-core-chatgpt-key.txt');
    const script = path.resolve('scripts/reset-agent-core-runtime.mjs');
    const run = spawnSync(process.execPath, [script, '--data-dir', dataDir, '--secret-file', secretFile], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    const secret = (await readFile(secretFile, 'utf8')).trim();
    expect(secret).toMatch(/^agent_core_live_[A-Za-z0-9_-]+$/);
    expect(run.stdout + run.stderr).not.toContain(secret);
    const store = new FileKeyStore(dataDir);
    expect((await store.verify(secret))?.name).toBe('chatgpt');
    const oauth = JSON.parse(await readFile(path.join(dataDir, 'oauth.json'), 'utf8')) as Record<string, unknown[]>;
    expect(oauth).toMatchObject({ clients: [], codes: [], accessTokens: [], refreshTokens: [] });
  });
});


describe('Agent Core capability path migration', () => {
  it('rewrites stale absolute capability provenance paths after a root rename', async () => {
    const target = await temp('agent-core-path-migrate-');
    const capabilityDir = path.join(target, 'capabilities');
    const provenanceDir = path.join(capabilityDir, 'provenance');
    await mkdir(provenanceDir, { recursive: true });
    const oldName = ['Com', 'mander-MCP'].join('');
    const fromRoot = `F:\\Projects\\${oldName}`;
    const toRoot = 'F:\\Projects\\Agent-Core';
    const file = path.join(provenanceDir, 'sample.json');
    await writeFile(file, JSON.stringify({
      sourcePath: `${fromRoot}\\capabilities\\cache\\source\\SKILL.md`,
      licensePath: `${fromRoot}\\capabilities\\cache\\source\\LICENSE`,
    }), 'utf8');
    const script = path.resolve('scripts/migrate-agent-core-capability-paths.mjs');
    const run = spawnSync(process.execPath, [script, '--capability-dir', capabilityDir, '--from-root', fromRoot, '--to-root', toRoot], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    const migrated = JSON.parse(await readFile(file, 'utf8')) as Record<string, string>;
    expect(migrated.sourcePath.startsWith(toRoot)).toBe(true);
    expect(migrated.licensePath.startsWith(toRoot)).toBe(true);
    expect(run.stdout).not.toContain(fromRoot);
  });
});