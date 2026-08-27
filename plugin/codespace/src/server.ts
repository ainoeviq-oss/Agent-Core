import path from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';

import { executeCommand } from './commands.js';
import { BRIDGE_NAME, BRIDGE_VERSION, MAX_COMMAND_OUTPUT_BYTES, RUNTIME_DIR, WORKSPACES_ROOT } from './constants.js';
import { errorPayload } from './errors.js';
import {
  editTextFile,
  listDirectory,
  readMultipleFiles,
  readTextFile,
  searchFiles,
  writeTextFile,
} from './filesystem.js';
import { ProcessManager } from './processes.js';
import { resolveWorkspaceRoot } from './workspace.js';

function textResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(error: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(error), null, 2) }],
    isError: true,
  };
}

async function guarded<T>(operation: () => Promise<T>) {
  try {
    return textResult(await operation());
  } catch (error) {
    return errorResult(error);
  }
}

async function main(): Promise<void> {
  // Defense in depth: the production launcher already removes these values.
  delete process.env.CONTROL_PLANE_API_KEY;
  delete process.env.OPENAI_ADMIN_KEY;

  const testAllowedBase =
    process.env.NODE_ENV === 'test' ? process.env.CODESPACE_TEST_ALLOWED_BASE : undefined;
  const allowedBase = testAllowedBase ?? WORKSPACES_ROOT;
  const root = await resolveWorkspaceRoot(allowedBase);
  const runtimeDir = process.env.NODE_ENV === 'test' ? path.join(root, '.codespace-runtime') : RUNTIME_DIR;
  const processes = new ProcessManager(root, runtimeDir, allowedBase);
  await processes.reconcile();

  const server = new McpServer({
    name: BRIDGE_NAME,
    title: 'codespace',
    version: BRIDGE_VERSION,
  });

  server.registerTool('codespace_status', {
    title: 'Codespace Status',
    description: 'Use to confirm the active codespace workspace, bridge version, runtime platform, and owned process count before development work.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => guarded(async () => {
    const branchResult = await executeCommand(root, { command: 'git branch --show-current', timeoutMs: 5000 }, allowedBase);
    return {
      name: BRIDGE_NAME,
      version: BRIDGE_VERSION,
      workspaceRoot: root,
      platform: `${process.platform}/${process.arch}`,
      branch: branchResult.exitCode === 0 ? branchResult.stdout.trim() || undefined : undefined,
      processSessions: processes.list().length,
    };
  }));

  server.registerTool('list_directory', {
    title: 'List Directory',
    description: 'Use to inspect files and folders inside the active codespace workspace without leaving its boundary.',
    inputSchema: {
      path: z.string().default('.'),
      depth: z.number().int().min(1).max(20).default(1),
      maxResults: z.number().int().min(1).max(5000).default(200),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ path: requestedPath, depth, maxResults }) => guarded(
    () => listDirectory(root, { path: requestedPath, depth, maxResults }, allowedBase),
  ));

  server.registerTool('read_file', {
    title: 'Read File',
    description: 'Use to read one UTF-8 text file inside the active codespace workspace.',
    inputSchema: { path: z.string().min(1) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ path: requestedPath }) => guarded(
    () => readTextFile(root, { path: requestedPath }, allowedBase),
  ));

  server.registerTool('read_multiple_files', {
    title: 'Read Multiple Files',
    description: 'Use to read a bounded batch of UTF-8 text files inside the active codespace workspace.',
    inputSchema: { paths: z.array(z.string().min(1)).min(1).max(50) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ paths }) => guarded(() => readMultipleFiles(root, paths, allowedBase)));

  server.registerTool('search_files', {
    title: 'Search Files',
    description: 'Use to search filenames or UTF-8 text content recursively inside the active codespace workspace.',
    inputSchema: {
      query: z.string().min(1),
      mode: z.enum(['filename', 'content']).default('filename'),
      path: z.string().optional(),
      maxResults: z.number().int().min(1).max(5000).default(100),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ query, mode, path: requestedPath, maxResults }) => guarded(
    () => searchFiles(root, { query, mode, path: requestedPath, maxResults }, allowedBase),
  ));

  server.registerTool('write_file', {
    title: 'Write File',
    description: 'Use to create, replace, or append UTF-8 text in one file inside the active codespace workspace.',
    inputSchema: {
      path: z.string().min(1),
      content: z.string(),
      mode: z.enum(['rewrite', 'append']).default('rewrite'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ path: requestedPath, content, mode }) => guarded(
    () => writeTextFile(root, { path: requestedPath, content, mode }, allowedBase),
  ));

  server.registerTool('edit_file', {
    title: 'Edit File',
    description: 'Use to make an exact text replacement in one workspace file when the expected match count is known.',
    inputSchema: {
      path: z.string().min(1),
      oldString: z.string().min(1),
      newString: z.string(),
      expectedReplacements: z.number().int().min(1).max(10000).default(1),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ path: requestedPath, oldString, newString, expectedReplacements }) => guarded(
    () => editTextFile(root, {
      path: requestedPath,
      oldString,
      newString,
      expectedReplacements,
    }, allowedBase),
  ));

  server.registerTool('execute_command', {
    title: 'Execute Command',
    description: 'Use to run one bounded bash command in the active codespace workspace, including builds, tests, Git, and diagnostics.',
    inputSchema: {
      command: z.string().min(1),
      cwd: z.string().optional(),
      timeoutMs: z.number().int().min(1).max(10 * 60_000).default(30_000),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ command, cwd, timeoutMs }) => guarded(
    () => executeCommand(root, { command, cwd, timeoutMs }, allowedBase),
  ));

  server.registerTool('start_process', {
    title: 'Start Process',
    description: 'Use to start one long-running bash process inside the active codespace workspace and receive an opaque session ID.',
    inputSchema: {
      command: z.string().min(1),
      cwd: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ command, cwd }) => guarded(() => processes.start({ command, cwd })));

  server.registerTool('read_process_output', {
    title: 'Read Process Output',
    description: 'Use to read bounded stdout, stderr, and state for a codespace-owned background process session.',
    inputSchema: {
      sessionId: z.string().min(1),
      maxBytes: z.number().int().min(1).max(MAX_COMMAND_OUTPUT_BYTES).default(MAX_COMMAND_OUTPUT_BYTES),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ sessionId, maxBytes }) => guarded(() => processes.read(sessionId, maxBytes)));

  server.registerTool('stop_process', {
    title: 'Stop Process',
    description: 'Use to stop one codespace-owned background process session by its opaque session ID.',
    inputSchema: { sessionId: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ sessionId }) => guarded(() => processes.stop(sessionId)));

  server.registerTool('list_processes', {
    title: 'List Processes',
    description: 'Use to list only background process sessions created and owned by this codespace bridge.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => textResult({ processes: processes.list() }));

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[codespace] MCP startup failed: ${message}`);
  process.exitCode = 1;
});
