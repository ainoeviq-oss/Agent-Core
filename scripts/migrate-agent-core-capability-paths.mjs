import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? '') : '';
}

const capabilityDir = path.resolve(arg('--capability-dir'));
const fromRoot = path.resolve(arg('--from-root'));
const toRoot = path.resolve(arg('--to-root'));
if (!arg('--capability-dir') || !arg('--from-root') || !arg('--to-root')) {
  throw new Error('--capability-dir, --from-root, and --to-root are required');
}

const fromLower = fromRoot.toLowerCase();
function migrateValue(value) {
  if (typeof value === 'string' && value.toLowerCase().startsWith(fromLower)) {
    return toRoot + value.slice(fromRoot.length);
  }
  if (Array.isArray(value)) return value.map(migrateValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, migrateValue(item)]));
  }
  return value;
}
async function collectJsonFiles(root) {
  const files = [];
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch { return files; }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await collectJsonFiles(full));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) files.push(full);
  }
  return files;
}

const roots = [
  path.join(capabilityDir, 'provenance'),
  path.join(capabilityDir, 'normalized'),
];
const files = (await Promise.all(roots.map(collectJsonFiles))).flat();
let migratedFileCount = 0;
for (const file of files) {
  const originalText = await readFile(file, 'utf8');
  const original = JSON.parse(originalText);
  const migrated = migrateValue(original);
  const nextText = `${JSON.stringify(migrated, null, 2)}\n`;
  if (nextText !== originalText) {
    await writeFile(file, nextText, 'utf8');
    migratedFileCount += 1;
  }
}
process.stdout.write(`${JSON.stringify({
  status: 'ok',
  migratedFileCount,
}, null, 2)}\n`);
