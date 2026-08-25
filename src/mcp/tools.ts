import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { VerifiedKey } from '../auth/key-types.js';
import { OperationalMemoryAudit } from '../memory/operational-audit.js';
import type { RuntimeServices } from '../runtime/services.js';
import { routeErrorResult, validateOperationalRoute } from './route-guard.js';

function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }, null, 2) }], isError: true };
}

async function guarded<T>(operation: () => Promise<T>) {
  try { return textResult(await operation()); }
  catch (error) { return errorResult(error); }
}

async function routeGuarded<T>(
  runtime: RuntimeServices,
  key: VerifiedKey,
  routeContextId: string,
  toolName: string,
  operation: () => Promise<T>,
  auditInput: Record<string, unknown> = {},
) {
  const audit = new OperationalMemoryAudit(runtime, key);
  let route;
  try {
    route = validateOperationalRoute(runtime, key, routeContextId, toolName);
  } catch (error) {
    await audit.rejected(routeContextId, toolName, auditInput, error);
    return routeErrorResult(error) ?? errorResult(error);
  }

  await audit.intended(route, toolName, auditInput);
  try {
    const result = await operation();
    await audit.succeeded(route, toolName, auditInput, result);
    return textResult(result);
  } catch (error) {
    await audit.failed(route, toolName, auditInput, error);
    return routeErrorResult(error) ?? errorResult(error);
  }
}

const ROUTE_REQUIRED_DESCRIPTION = 'Obtain routeContextId from capability_route before using this tool.';
const routedDescription = (description: string) => `${description} ${ROUTE_REQUIRED_DESCRIPTION}`;

export const OPERATIONAL_TOOL_NAMES = [
  'workspace_info', 'list_directory', 'read_file', 'read_multiple_files',
  'write_file', 'edit_file', 'create_directory', 'move_file', 'get_file_info',
  'search_files', 'execute_command', 'start_process', 'read_process_output',
  'stop_process', 'list_processes',
] as const;

export function registerOperationalTools(
  server: McpServer,
  runtime: RuntimeServices,
  key: VerifiedKey,
): void {
  server.registerTool('workspace_info', {
    title: 'Workspace Info',
    description: 'Show the filesystem roots this Agent Core identity is allowed to access.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => textResult({ roots: runtime.workspace.roots }));

  server.registerTool('list_directory', {
    title: 'List Directory',
    description: routedDescription('List files and directories inside an allowed workspace, optionally descending several levels.'),
    inputSchema: {
      path: z.string(),
      depth: z.number().int().min(1).max(10).default(2),
      maxEntries: z.number().int().min(1).max(2000).default(500),
      routeContextId: z.string().uuid(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ path, depth, maxEntries, routeContextId }) => routeGuarded(
    runtime, key, routeContextId, 'list_directory',
    () => runtime.filesystem.listDirectory(path, depth, maxEntries),
    { path, depth, maxEntries },
  ));

  server.registerTool('read_file', {
    title: 'Read File',
    description: routedDescription('Read a UTF-8 text file from an allowed workspace, with optional line and byte bounds.'),
    inputSchema: {
      path: z.string(),
      startLine: z.number().int().min(0).optional(),
      lineCount: z.number().int().min(1).max(10000).optional(),
      maxBytes: z.number().int().min(1).max(5 * 1024 * 1024).optional(),
      routeContextId: z.string().uuid(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ path, startLine, lineCount, maxBytes, routeContextId }) => routeGuarded(
    runtime, key, routeContextId, 'read_file',
    () => runtime.filesystem.readFile(path, { startLine, lineCount, maxBytes }),
    { path, startLine, lineCount, maxBytes },
  ));

  server.registerTool('read_multiple_files', {
    title: 'Read Multiple Files',
    description: routedDescription('Read several UTF-8 text files from allowed workspaces in one call.'),
    inputSchema: {
      paths: z.array(z.string()).min(1).max(50),
      startLine: z.number().int().min(0).optional(),
      lineCount: z.number().int().min(1).max(10000).optional(),
      maxBytes: z.number().int().min(1).max(5 * 1024 * 1024).optional(),
      routeContextId: z.string().uuid(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ paths, startLine, lineCount, maxBytes, routeContextId }) => routeGuarded(
    runtime, key, routeContextId, 'read_multiple_files',
    () => runtime.filesystem.readMultipleFiles(paths, { startLine, lineCount, maxBytes }),
    { paths, startLine, lineCount, maxBytes },
  ));

  server.registerTool('write_file', {
    title: 'Write File',
    description: routedDescription('Create, replace, or append UTF-8 text in a file inside an allowed workspace.'),
    inputSchema: {
      path: z.string(),
      content: z.string(),
      mode: z.enum(['rewrite', 'append']).default('rewrite'),
      routeContextId: z.string().uuid(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ path, content, mode, routeContextId }) => routeGuarded(
    runtime, key, routeContextId, 'write_file',
    () => runtime.filesystem.writeFile(path, content, mode),
    { path, mode, contentBytes: Buffer.byteLength(content, 'utf8') },
  ));

  server.registerTool('edit_file', {
    title: 'Edit File',
    description: routedDescription('Replace an exact text block in a file and reject the edit when the match count is not exactly what was expected.'),
    inputSchema: {
      path: z.string(),
      oldString: z.string().min(1),
      newString: z.string(),
      expectedReplacements: z.number().int().min(1).max(10000).default(1),
      routeContextId: z.string().uuid(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ path, oldString, newString, expectedReplacements, routeContextId }) => routeGuarded(
    runtime, key, routeContextId, 'edit_file',
    () => runtime.filesystem.editFile(path, oldString, newString, expectedReplacements),
    {
      path,
      expectedReplacements,
      oldStringBytes: Buffer.byteLength(oldString, 'utf8'),
      newStringBytes: Buffer.byteLength(newString, 'utf8'),
    },
  ));

  server.registerTool('create_directory', {
    title: 'Create Directory',
    description: routedDescription('Create a directory, including missing parent directories, inside an allowed workspace.'),
    inputSchema: { path: z.string(), routeContextId: z.string().uuid() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ path, routeContextId }) => routeGuarded(
    runtime, key, routeContextId, 'create_directory',
    () => runtime.filesystem.createDirectory(path),
    { path },
  ));

  server.registerTool('move_file', {
    title: 'Move File',
    description: routedDescription('Move or rename a file or directory between locations that are both inside allowed workspaces.'),
    inputSchema: {
      source: z.string(),
      destination: z.string(),
      routeContextId: z.string().uuid(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ source, destination, routeContextId }) => routeGuarded(
    runtime, key, routeContextId, 'move_file',
    () => runtime.filesystem.moveFile(source, destination),
    { source, destination },
  ));

  server.registerTool('get_file_info', {
    title: 'Get File Info',
    description: routedDescription('Return metadata for a file or directory inside an allowed workspace.'),
    inputSchema: { path: z.string(), routeContextId: z.string().uuid() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ path, routeContextId }) => routeGuarded(
    runtime, key, routeContextId, 'get_file_info',
    () => runtime.filesystem.getFileInfo(path),
    { path },
  ));

  server.registerTool('search_files', {
    title: 'Search Files',
    description: routedDescription('Search recursively by filename or UTF-8 text content inside an allowed workspace.'),
    inputSchema: {
      path: z.string(),
      query: z.string().min(1),
      mode: z.enum(['files', 'content']).default('files'),
      maxResults: z.number().int().min(1).max(1000).default(100),
      routeContextId: z.string().uuid(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ path, query, mode, maxResults, routeContextId }) => routeGuarded(
    runtime, key, routeContextId, 'search_files',
    () => runtime.search.search({ path, query, mode, maxResults }),
    { path, query, mode, maxResults },
  ));

  server.registerTool('execute_command', {
    title: 'Execute Command',
    description: routedDescription('Run a PowerShell command once in an allowed working directory with timeout and output bounds. High-risk system commands are blocked.'),
    inputSchema: {
      command: z.string().min(1),
      cwd: z.string().optional(),
      timeoutMs: z.number().int().min(1).max(10 * 60_000).default(30_000),
      routeContextId: z.string().uuid(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ command, cwd, timeoutMs, routeContextId }) => {
    const resolvedCwd = cwd ?? runtime.workspace.roots[0]!;
    return routeGuarded(
      runtime, key, routeContextId, 'execute_command',
      () => runtime.processes.execute(command, { cwd: resolvedCwd, timeoutMs }),
      { command, cwd: resolvedCwd, timeoutMs },
    );
  });

  server.registerTool('start_process', {
    title: 'Start Process',
    description: routedDescription('Start a long-running PowerShell command in an allowed working directory and return an opaque process session ID.'),
    inputSchema: {
      command: z.string().min(1),
      cwd: z.string().optional(),
      routeContextId: z.string().uuid(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ command, cwd, routeContextId }) => {
    const resolvedCwd = cwd ?? runtime.workspace.roots[0]!;
    return routeGuarded(
      runtime, key, routeContextId, 'start_process',
      () => runtime.processes.start(command, { cwd: resolvedCwd }),
      { command, cwd: resolvedCwd },
    );
  });

  server.registerTool('read_process_output', {
    title: 'Read Process Output',
    description: 'Read the bounded stdout/stderr snapshot and state of a Agent Core process session.',
    inputSchema: { sessionId: z.string().min(1) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ sessionId }) => {
    try { return textResult(runtime.processes.read(sessionId)); }
    catch (error) { return errorResult(error); }
  });

  server.registerTool('stop_process', {
    title: 'Stop Process',
    description: 'Stop a Agent Core-managed process session.',
    inputSchema: { sessionId: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ sessionId }) => guarded(() => runtime.processes.stop(sessionId)));

  server.registerTool('list_processes', {
    title: 'List Processes',
    description: 'List only the process sessions started and tracked by this Agent Core runtime.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => textResult({ processes: runtime.processes.list() }));
}
