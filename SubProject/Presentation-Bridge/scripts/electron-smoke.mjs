import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const electron = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
await access(electron);

const command = process.platform === 'linux' ? 'xvfb-run' : electron;
const args = process.platform === 'linux'
  ? ['-a', electron, '.', '--no-sandbox']
  : ['.'];

const child = spawn(command, args, {
  cwd: root,
  env: { ...process.env, PB_ELECTRON_SMOKE: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
});

let output = '';
for (const stream of [child.stdout, child.stderr]) {
  stream.on('data', (chunk) => {
    output += chunk.toString();
    if (output.length > 200_000) output = output.slice(-200_000);
  });
}

const code = await new Promise((resolveExit, reject) => {
  child.once('error', reject);
  child.once('close', resolveExit);
});
const marker = output.match(/PB_ELECTRON_SMOKE_READY\s+(\{[^\n]+\})/);
if (code !== 0 || !marker) {
  process.stderr.write(output);
  throw new Error(`Electron smoke failed with exit code ${String(code)}.`);
}
const result = JSON.parse(marker[1]);
if (result.project !== 'Presentation-Bridge' || result.version !== '0.2.0') {
  throw new Error(`Electron IPC smoke returned unexpected result: ${marker[1]}`);
}
console.log(`PB_ELECTRON_SMOKE=PASS project=${result.project} version=${result.version}`);
