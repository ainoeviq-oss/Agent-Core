import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..', '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const changelog = await readFile(path.join(root, 'CHANGELOG.md'), 'utf8');
const version = pkg.version;
const heading = `## [${version}]`;
const start = changelog.indexOf(heading);
if (start < 0) throw new Error(`No changelog section for ${version}`);
const next = changelog.indexOf('\n## [', start + heading.length);
const section = changelog.slice(start, next < 0 ? changelog.length : next).trim() + '\n';
const output = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'release-notes.md');
await writeFile(output, section, 'utf8');
process.stdout.write(`${output}\n`);
