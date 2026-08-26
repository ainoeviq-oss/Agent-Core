import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGitHubLiveAcceptance } from '../dist/github/live-acceptance.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const baseDir = path.resolve(scriptDir, '..');
const result = await runGitHubLiveAcceptance({ env: process.env, baseDir });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.attempted && !result.ok) process.exitCode = 2;
