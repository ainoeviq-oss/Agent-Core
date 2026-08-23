import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCatalog } from '../dist/capabilities/catalog-parser.js';
import { writeRegistryGeneration } from '../dist/capabilities/registry-writer.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const worktreeRoot = path.resolve(scriptDir, '..');
const gitCommonRaw = execFileSync(
  'git', ['-C', worktreeRoot, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' },
).trim();
const gitCommon = path.isAbsolute(gitCommonRaw)
  ? gitCommonRaw
  : path.resolve(worktreeRoot, gitCommonRaw);
const projectRoot = path.dirname(gitCommon);
const capabilityDir = path.resolve(
  process.env.AGENT_CORE_CAPABILITY_DIR?.trim() || path.join(projectRoot, 'capabilities'),
);
const catalogDir = path.join(capabilityDir, 'sources', 'awesome-korean-agent-skills');

function git(args, options = {}) {
  return execFileSync('git', args, { encoding: 'utf8', ...options }).trim();
}

if (existsSync(path.join(catalogDir, '.git'))) {
  execFileSync('git', ['-C', catalogDir, 'fetch', 'origin', 'main'], { stdio: 'inherit' });
  execFileSync('git', ['-C', catalogDir, 'checkout', 'main'], { stdio: 'inherit' });
  execFileSync('git', ['-C', catalogDir, 'merge', '--ff-only', 'origin/main'], { stdio: 'inherit' });
} else {
  execFileSync(
    'git',
    ['clone', '--filter=blob:none', 'https://github.com/J-nowcow/awesome-korean-agent-skills.git', catalogDir],
    { stdio: 'inherit' },
  );
}

const catalogSha = git(['-C', catalogDir, 'rev-parse', 'HEAD']);
const records = await parseCatalog(catalogDir, catalogSha);
const coverage = await writeRegistryGeneration(capabilityDir, records, { catalogSha });

process.stdout.write(`${JSON.stringify({
  capabilityDir,
  catalogDir,
  catalogSha,
  coverage,
}, null, 2)}\n`);
