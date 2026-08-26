import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAgentCorePluginPackage } from '../dist/plugin/package-builder.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const checkoutRoot = path.resolve(scriptDir, '..');
const commonGitDir = execFileSync(
  'git', ['-C', checkoutRoot, 'rev-parse', '--git-common-dir'],
  { encoding: 'utf8' },
).trim();
const resolvedGitDir = path.resolve(checkoutRoot, commonGitDir);
const agentCoreHome = path.dirname(resolvedGitDir);
const capabilityDir = path.resolve(
  process.env.AGENT_CORE_CAPABILITY_DIR || path.join(agentCoreHome, 'capabilities'),
);
const outputDir = path.resolve(
  process.env.AGENT_CORE_PLUGIN_OUTPUT_DIR || path.join(checkoutRoot, 'plugin', 'agent-core', 'generated'),
);
const routerSkillPath = path.join(
  checkoutRoot, 'plugin', 'agent-core', 'skills', 'agent-core-capability-router', 'SKILL.md',
);
const githubSkillPath = path.join(
  checkoutRoot, 'plugin', 'agent-core', 'skills', 'agent-core-github', 'SKILL.md',
);
const result = await buildAgentCorePluginPackage({
  capabilityDir,
  outputDir,
  routerSkillPath,
  githubSkillPath,
});

process.stdout.write(`${JSON.stringify({
  agentCoreHome,
  capabilityDir,
  outputDir: result.outputDir,
  nativeSkillCount: result.nativeSkillCount,
  skills: result.skills,
}, null, 2)}\n`);
