import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const FORBIDDEN = [
  /Agent[- ]Core/i,
  /Market[- ]Signal[- ]Lab/i,
  /NeuraCore/i,
  /n8n/i
];

export async function auditSourceIsolation(root: string): Promise<{ clean: boolean; findings: Array<{ path: string; match: string }> }> {
  const findings: Array<{ path: string; match: string }> = [];
  const sourceRoot = join(root, 'src');
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (['.ts', '.js', '.mjs', '.json'].includes(extname(entry.name)) && !path.endsWith(join('security', 'isolation.ts'))) {
        const text = await readFile(path, 'utf8');
        for (const pattern of FORBIDDEN) {
          const hit = text.match(pattern);
          if (hit) findings.push({ path, match: hit[0] });
        }
      }
    }
  }
  await walk(sourceRoot);
  return { clean: findings.length === 0, findings };
}
