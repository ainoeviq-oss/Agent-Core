import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const legacy = [
  ['Desktop ', 'Commander'].join(''),
  ['desktop-', 'commander'].join(''),
  ['Commander', '-MCP'].join(''),
  ['commander', '-mcp'].join(''),
  ['COMMANDER', '_'].join(''),
  ['cmd', 'r_'].join(''),
  ['commander', '_'].join(''),
  ['commander', '-'].join(''),
  ['Com', 'mander'].join(''),
];
const migrationHistory = new Set([
  'docs/superpowers/specs/2026-08-23-agent-core-hard-rebrand-design.md',
  'docs/superpowers/plans/2026-08-23-agent-core-hard-rebrand.md',
]);

async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else files.push(full);
  }
  return files;
}
function trackedFiles() {
  return execFileSync('git', ['-C', repoRoot, 'ls-files', '-z'], { encoding: 'utf8' })
    .split('\0').filter(Boolean)
    .filter((file) => !migrationHistory.has(file.replaceAll('\\', '/')))
    .filter((file) => !file.replaceAll('\\', '/').startsWith('capabilities/sources/'))
    .map((file) => path.join(repoRoot, file));
}

const scanIndex = process.argv.indexOf('--scan-path');
const scanRoot = scanIndex >= 0 ? path.resolve(process.argv[scanIndex + 1] ?? '') : null;
const files = scanRoot ? await walk(scanRoot) : trackedFiles();
const base = scanRoot ?? repoRoot;
const findings = [];
for (const file of files) {
  const display = path.relative(base, file).replaceAll('\\', '/');
  for (const token of legacy) if (display.includes(token)) findings.push(`${display}:path:${token}`);
  let text;
  try { text = await readFile(file, 'utf8'); } catch { continue; }
  text.split(/\r?\n/).forEach((line, index) => {
    for (const token of legacy) if (line.includes(token)) findings.push(`${display}:${index + 1}:${token}`);
  });
}

if (findings.length) {
  process.stderr.write(`${findings.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('Agent Core brand scan clean\n');
}
