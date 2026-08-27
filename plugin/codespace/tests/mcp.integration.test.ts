import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let base: string;
let root: string;

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'codespace-mcp-'));
  root = path.join(base, 'repo');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'seed.txt'), 'seed value', 'utf8');
});

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

function transportEnvironment(): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return {
    ...env,
    NODE_ENV: 'test',
    CODESPACE_WORKSPACE_ROOT: root,
    CODESPACE_TEST_ALLOWED_BASE: base,
    CONTROL_PLANE_API_KEY: 'must-not-reach-shell',
  };
}

describe('codespace MCP stdio server', () => {
  it('initializes, exposes the bounded tool surface, and executes real workspace operations', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['plugin/codespace/dist/server.js'],
      env: transportEnvironment(),
      stderr: 'pipe',
    });
    const client = new Client({ name: 'codespace-test', version: '1.0.0' });

    try {
      await client.connect(transport);

      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining([
        'codespace_status',
        'list_directory',
        'read_file',
        'read_multiple_files',
        'search_files',
        'write_file',
        'edit_file',
        'execute_command',
        'start_process',
        'read_process_output',
        'stop_process',
        'list_processes',
      ]));

      const readSeed = await client.callTool({
        name: 'read_file',
        arguments: { path: 'seed.txt' },
      });
      expect(JSON.stringify(readSeed)).toContain('seed value');

      await client.callTool({
        name: 'write_file',
        arguments: { path: 'created.txt', content: 'hello', mode: 'rewrite' },
      });
      await client.callTool({
        name: 'edit_file',
        arguments: {
          path: 'created.txt',
          oldString: 'hello',
          newString: 'world',
          expectedReplacements: 1,
        },
      });
      const edited = await client.callTool({
        name: 'read_file',
        arguments: { path: 'created.txt' },
      });
      expect(JSON.stringify(edited)).toContain('world');

      const pwd = await client.callTool({
        name: 'execute_command',
        arguments: { command: 'pwd' },
      });
      expect(JSON.stringify(pwd)).toContain(root);

      const credentialProbe = await client.callTool({
        name: 'execute_command',
        arguments: { command: 'printf %s "${CONTROL_PLANE_API_KEY-unset}"' },
      });
      expect(JSON.stringify(credentialProbe)).toContain('unset');
      expect(JSON.stringify(credentialProbe)).not.toContain('must-not-reach-shell');
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});
