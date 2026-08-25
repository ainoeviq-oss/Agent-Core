import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..', '..');
const tracked = execFileSync('git', ['-C', root, 'ls-files', '-z', '*.md'], { encoding: 'utf8' })
  .split('\0').filter(Boolean);
const failures = [];
let checked = 0;

for (const relativeFile of tracked) {
  const file = path.join(root, relativeFile);
  const text = await readFile(file, 'utf8');
  const regex = /!?(?:\[[^\]]*\])\(([^)]+)\)/g;
  for (const match of text.matchAll(regex)) {
    let target = match[1].trim();
    if (!target || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
    target = target.split('#', 1)[0].split('?', 1)[0];
    if (!target) continue;
    const decoded = decodeURIComponent(target);
    const resolved = path.resolve(path.dirname(file), decoded.replaceAll('/', path.sep));
    const rel = path.relative(root, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      failures.push(`${relativeFile}: link escapes repository: ${match[1]}`);
      continue;
    }
    checked += 1;
    try {
      await stat(resolved);
    } catch {
      failures.push(`${relativeFile}: missing link target: ${match[1]}`);
    }
  }
}

if (failures.length) {
  process.stderr.write(failures.join('\n') + '\n');
  process.exit(1);
}
process.stdout.write(JSON.stringify({ ok: true, markdownFiles: tracked.length, relativeLinksChecked: checked }, null, 2) + '\n');
