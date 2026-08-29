import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = path.join(pluginRoot, 'dist', 'http-server.js');

let base: string;
let root: string;
let urlFile: string;
let child: ChildProcess | undefined;
let childStderr = '';

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'codespace-http-mcp-'));
  root = path.join(base, 'repo');
  urlFile = path.join(base, 'http-mcp.url');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'seed.txt'), 'seed value', 'utf8');
});

afterEach(async () => {
  if (child?.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      child?.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  child = undefined;
  childStderr = '';
  await fs.rm(base, { recursive: true, force: true });
});

function serverEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'test',
    CODESPACE_WORKSPACE_ROOT: root,
    CODESPACE_TEST_ALLOWED_BASE: base,
    CODESPACE_MCP_HTTP_HOST: '127.0.0.1',
    CODESPACE_MCP_HTTP_PORT: '0',
    CODESPACE_MCP_HTTP_URL_FILE: urlFile,
    CONTROL_PLANE_API_KEY: 'must-not-reach-shell',
  };
}

async function waitForUrl(): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const value = (await fs.readFile(urlFile, 'utf8')).trim();
      if (value) return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`HTTP MCP server exited before readiness: ${childStderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`HTTP MCP URL file was not written: ${childStderr}`);
}

describe('codespace MCP loopback Streamable HTTP server', () => {
  it('health-checks, initializes, exposes the bounded tool surface, and isolates credentials', async () => {
    child = spawn(process.execPath, [serverEntry], {
      cwd: pluginRoot,
      env: serverEnvironment(),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      childStderr += chunk;
    });

    const mcpUrl = await waitForUrl();
    expect(mcpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

    const healthResponse = await fetch(new URL('/healthz', mcpUrl));
    expect(healthResponse.status).toBe(200);
    await expect(healthResponse.json()).resolves.toMatchObject({
      name: 'codespace',
      status: 'ok',
      transport: 'streamable-http',
    });

    const client = new Client({ name: 'codespace-http-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));

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
