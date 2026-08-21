import { pathToFileURL } from 'node:url';
import { FileKeyStore } from './auth/key-store.js';
import { loadConfig } from './config.js';

export interface CliOptions {
  dataDir?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

const USAGE = [
  'Usage:',
  '  commander-mcp create-key <name>',
  '  commander-mcp list-keys',
  '  commander-mcp revoke-key <id>',
  '  commander-mcp rotate-key <id>',
].join('\n');

export async function runCli(args: string[], options: CliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const stderr = options.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const dataDir = options.dataDir ?? loadConfig().dataDir;
  const store = new FileKeyStore(dataDir);
  const [command, value] = args;

  try {
    switch (command) {
      case 'create-key': {
        if (!value) return usageError(stderr);
        const created = await store.create(value);
        stdout(JSON.stringify(created, null, 2));
        return 0;
      }
      case 'list-keys': {
        stdout(JSON.stringify(await store.list(), null, 2));
        return 0;
      }
      case 'revoke-key': {
        if (!value) return usageError(stderr);
        const revoked = await store.revoke(value);
        if (!revoked) {
          stderr(`Key not found: ${value}`);
          return 1;
        }
        stdout(JSON.stringify({ id: value, revoked: true }, null, 2));
        return 0;
      }
      case 'rotate-key': {
        if (!value) return usageError(stderr);
        const rotated = await store.rotate(value);
        stdout(JSON.stringify(rotated, null, 2));
        return 0;
      }
      default:
        return usageError(stderr);
    }
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function usageError(stderr: (line: string) => void): number {
  stderr(USAGE);
  return 2;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
