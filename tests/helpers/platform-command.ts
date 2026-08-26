import { Buffer } from 'node:buffer';

export function nodeShellCommand(source: string): string {
  const encoded = Buffer.from(source, 'utf8').toString('base64');
  return `node -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`;
}

export function printCommand(stdout: string, stderr = '', exitCode = 0): string {
  return nodeShellCommand([
    `process.stdout.write(${JSON.stringify(stdout)});`,
    stderr ? `process.stderr.write(${JSON.stringify(stderr)});` : '',
    `process.exitCode = ${exitCode};`,
  ].filter(Boolean).join(''));
}

export function sleepCommand(ms: number, before = '', after = ''): string {
  return nodeShellCommand([
    before ? `process.stdout.write(${JSON.stringify(before)});` : '',
    `setTimeout(() => {`,
    after ? `process.stdout.write(${JSON.stringify(after)});` : '',
    `}, ${Math.max(0, Math.floor(ms))});`,
  ].filter(Boolean).join(''));
}

export function retryMarkerCommand(markerPath: string): string {
  return nodeShellCommand(`
    const fs = require('node:fs');
    const marker = ${JSON.stringify(markerPath)};
    if (fs.existsSync(marker)) {
      process.stdout.write('attempt-two');
      process.exitCode = 0;
    } else {
      fs.writeFileSync(marker, 'seen');
      process.stderr.write('attempt-one-failed');
      process.exitCode = 9;
    }
  `);
}
