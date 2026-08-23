import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCommanderPluginPackage } from '../dist/plugin/package-builder.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const checkoutRoot = path.resolve(scriptDir, '..');
const commonGitDir = execFileSync(
  'git', ['-C', checkoutRoot, 'rev-parse', '--git-common-dir'],
  { encoding: 'utf8' },
).trim();
const resolvedGitDir = path.resolve(checkoutRoot, commonGitDir);
const commanderHome = path.dirname(resolvedGitDir);
const capabilityDir = path.resolve(
  process.env.COMMANDER_CAPABILITY_DIR || path.join(commanderHome, 'capabilities'),
);
const outputDir = path.resolve(
  process.env.COMMANDER_PLUGIN_OUTPUT_DIR || path.join(checkoutRoot, 'plugin', 'commander', 'generated'),
);
const routerSkillPath = path.join(
  checkoutRoot, 'plugin', 'commander', 'skills', 'commander-capability-router', 'SKILL.md',
);
const result = await buildCommanderPluginPackage({
  capabilityDir,
  outputDir,
  routerSkillPath,
});

process.stdout.write(`${JSON.stringify({
  commanderHome,
  capabilityDir,
  outputDir: result.outputDir,
  nativeSkillCount: result.nativeSkillCount,
  skills: result.skills,
}, null, 2)}\n`);
