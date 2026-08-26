import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { VerifiedKey } from '../auth/key-types.js';
import type { GitHubApiRequest } from '../github/api-service.js';
import { GitHubFabricError } from '../github/errors.js';
import { assertDestructiveConfirmation } from '../github/safety.js';
import { OperationalMemoryAudit } from '../memory/operational-audit.js';
import { AgentCoreRouteError, type RouteContext } from '../runtime/route-context-store.js';
import type { RuntimeServices } from '../runtime/services.js';
import { routeErrorResult, validateOperationalRoute } from './route-guard.js';

const ROUTE_REQUIRED_DESCRIPTION = 'Obtain routeContextId from capability_route before using this tool.';
const routedDescription = (description: string) => `${description} ${ROUTE_REQUIRED_DESCRIPTION}`;

export const GITHUB_TOOL_NAMES = [
  'github_status', 'github_repo', 'github_git', 'github_issue', 'github_pr',
  'github_actions', 'github_release', 'github_packages', 'github_api',
] as const;

const jsonObject = z.record(z.string(), z.unknown());
const stringRecord = z.record(z.string(), z.string());
const queryRecord = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error: unknown) {
  if (error instanceof GitHubFabricError || error instanceof AgentCoreRouteError) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({
        error: {
          code: error.code,
          message: error.message,
          ...('details' in error && error.details ? { details: error.details } : {}),
        },
      }, null, 2) }],
      isError: true as const,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: { code: 'GITHUB_FABRIC_ERROR', message } }, null, 2) }],
    isError: true as const,
  };
}

function safeAuditInput(input: Record<string, unknown>): Record<string, unknown> {
  const keys = [
    'operation', 'owner', 'repo', 'org', 'method', 'endpoint', 'cwd', 'destination', 'remote',
    'ref', 'refspec', 'branch', 'workflow', 'issueNumber', 'pullNumber', 'runId', 'releaseId',
    'assetPath', 'packageType', 'packageName', 'versionId', 'packageSpec', 'force', 'tag',
  ];
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
      output[key] = value;
    }
  }
  return output;
}

function atomicReadOnly(route: RouteContext): boolean {
  return route.tier === 'atomic' && route.verification.required === false;
}

function isMutation(toolName: string, input: Record<string, unknown>): boolean {
  const operation = typeof input.operation === 'string' ? input.operation : '';
  if (toolName === 'github_repo') return ['create', 'update', 'archive', 'transfer', 'delete'].includes(operation);
  if (toolName === 'github_git') return ['clone', 'fetch', 'pull', 'push', 'remote_set_url'].includes(operation);
  if (toolName === 'github_issue') return ['create', 'update', 'close', 'comment'].includes(operation);
  if (toolName === 'github_pr') return ['create', 'update', 'review', 'merge', 'comment'].includes(operation);
  if (toolName === 'github_actions') return ['dispatch', 'cancel', 'rerun', 'rerun_failed'].includes(operation);
  if (toolName === 'github_release') return ['create', 'edit', 'delete', 'upload_asset'].includes(operation);
  if (toolName === 'github_packages') return ['delete_version', 'restore_version', 'npm_publish', 'npm_install'].includes(operation);
  if (toolName === 'github_api') return String(input.method ?? 'GET').toUpperCase() !== 'GET';
  return false;
}

async function githubRouteGuarded<T>(
  runtime: RuntimeServices,
  key: VerifiedKey,
  routeContextId: string,
  toolName: string,
  rawInput: Record<string, unknown>,
  operation: () => Promise<T>,
) {
  const audit = new OperationalMemoryAudit(runtime, key);
  const auditInput = safeAuditInput(rawInput);
  let route: RouteContext;
  try {
    route = validateOperationalRoute(runtime, key, routeContextId, toolName);
    if (atomicReadOnly(route) && isMutation(toolName, rawInput)) {
      throw new AgentCoreRouteError(
        'ROUTE_TOOL_NOT_ALLOWED',
        `Read-only route cannot perform mutating GitHub operation through ${toolName}`,
      );
    }
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

function requiredString(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new GitHubFabricError('GITHUB_API_VALIDATION_FAILED', `${label} is required`);
  return value.trim();
}

function requiredNumber(value: number | undefined, label: string): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) < 1) throw new GitHubFabricError('GITHUB_API_VALIDATION_FAILED', `${label} must be a positive integer`);
  return value!;
}

export function registerGitHubTools(server: McpServer, runtime: RuntimeServices, key: VerifiedKey): void {
  server.registerTool('github_status', {
    title: 'GitHub Fabric Status',
    description: 'Report local Native GitHub Fabric configuration, credential-file presence, and Git availability without reading credential contents or contacting GitHub.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    try { return textResult(await runtime.github.status()); }
    catch (error) { return errorResult(error); }
  });

  server.registerTool('github_repo', {
    title: 'GitHub Repositories',
    description: routedDescription('Read, list, create, update, archive, transfer, or delete GitHub repositories through the Native GitHub Fabric.'),
    inputSchema: {
      operation: z.enum(['get', 'list', 'create', 'update', 'archive', 'transfer', 'delete']),
      owner: z.string().optional(), repo: z.string().optional(), org: z.string().optional(),
      body: jsonObject.optional(), perPage: z.number().int().min(1).max(100).optional(), page: z.number().int().min(1).optional(),
      destructiveConfirmation: z.string().optional(), routeContextId: z.string().uuid(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async (input) => githubRouteGuarded(runtime, key, input.routeContextId, 'github_repo', input, () => runtime.github.repo(input)));

  server.registerTool('github_git', {
    title: 'GitHub Git Transport',
    description: routedDescription('Clone, fetch, pull, push, inspect refs, or manage canonical HTTPS GitHub remotes using ephemeral credentials.'),
    inputSchema: {
      operation: z.enum(['clone', 'fetch', 'pull', 'push', 'ls_remote', 'remote_get_url', 'remote_set_url']),
      owner: z.string().optional(), repo: z.string().optional(), cwd: z.string().optional(), destination: z.string().optional(),
      remote: z.string().optional(), ref: z.string().optional(), refspec: z.string().optional(), refs: z.array(z.string()).max(100).optional(),
      url: z.string().optional(), force: z.boolean().optional(), destructiveConfirmation: z.string().optional(), routeContextId: z.string().uuid(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async (input) => githubRouteGuarded(runtime, key, input.routeContextId, 'github_git', input, async () => {
    if (input.operation === 'clone') return runtime.github.git.clone({ owner: requiredString(input.owner, 'owner'), repo: requiredString(input.repo, 'repo'), destination: requiredString(input.destination, 'destination') });
    if (input.operation === 'fetch') return runtime.github.git.fetch({ cwd: requiredString(input.cwd, 'cwd'), remote: input.remote, refspec: input.refspec });
    if (input.operation === 'pull') return runtime.github.git.pull({ cwd: requiredString(input.cwd, 'cwd'), remote: input.remote, ref: input.ref });
    if (input.operation === 'push') return runtime.github.git.push({ cwd: requiredString(input.cwd, 'cwd'), remote: input.remote, refspec: input.refspec, force: input.force, destructiveConfirmation: input.destructiveConfirmation });
    if (input.operation === 'ls_remote') return runtime.github.git.lsRemote({ owner: requiredString(input.owner, 'owner'), repo: requiredString(input.repo, 'repo'), refs: input.refs });
    if (input.operation === 'remote_get_url') return runtime.github.git.remoteGetUrl({ cwd: requiredString(input.cwd, 'cwd'), remote: input.remote });
    return runtime.github.git.remoteSetUrl({ cwd: requiredString(input.cwd, 'cwd'), remote: input.remote, url: requiredString(input.url, 'url') });
  }));

  server.registerTool('github_issue', {
    title: 'GitHub Issues',
    description: routedDescription('List, read, create, update, close, or comment on GitHub issues.'),
    inputSchema: {
      operation: z.enum(['list', 'get', 'create', 'update', 'close', 'comment']), owner: z.string(), repo: z.string(),
      issueNumber: z.number().int().positive().optional(), body: jsonObject.optional(), perPage: z.number().int().min(1).max(100).optional(),
      page: z.number().int().min(1).optional(), routeContextId: z.string().uuid(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (input) => githubRouteGuarded(runtime, key, input.routeContextId, 'github_issue', input, () => runtime.github.issue(input)));

  server.registerTool('github_pr', {
    title: 'GitHub Pull Requests',
    description: routedDescription('List, read, create, update, review, comment on, or merge GitHub pull requests.'),
    inputSchema: {
      operation: z.enum(['list', 'get', 'create', 'update', 'review', 'merge', 'comment']), owner: z.string(), repo: z.string(),
      pullNumber: z.number().int().positive().optional(), body: jsonObject.optional(), perPage: z.number().int().min(1).max(100).optional(),
      page: z.number().int().min(1).optional(), destructiveConfirmation: z.string().optional(), routeContextId: z.string().uuid(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async (input) => githubRouteGuarded(runtime, key, input.routeContextId, 'github_pr', input, () => runtime.github.pr(input)));

  server.registerTool('github_actions', {
    title: 'GitHub Actions',
    description: routedDescription('Inspect workflows/runs and dispatch, cancel, or rerun GitHub Actions workflows.'),
    inputSchema: {
      operation: z.enum(['list_workflows', 'list_runs', 'get_run', 'dispatch', 'cancel', 'rerun', 'rerun_failed']),
      owner: z.string(), repo: z.string(), workflow: z.string().optional(), runId: z.number().int().positive().optional(),
      ref: z.string().optional(), inputs: stringRecord.optional(), perPage: z.number().int().min(1).max(100).optional(), page: z.number().int().min(1).optional(),
      destructiveConfirmation: z.string().optional(), routeContextId: z.string().uuid(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async (input) => githubRouteGuarded(runtime, key, input.routeContextId, 'github_actions', input, () => runtime.github.actions(input)));

  server.registerTool('github_release', {
    title: 'GitHub Releases',
    description: routedDescription('List, read, create, edit, delete, or upload assets to GitHub Releases.'),
    inputSchema: {
      operation: z.enum(['list', 'get', 'get_by_tag', 'create', 'edit', 'delete', 'upload_asset']), owner: z.string(), repo: z.string(),
      releaseId: z.number().int().positive().optional(), tag: z.string().optional(), body: jsonObject.optional(), assetPath: z.string().optional(),
      assetName: z.string().optional(), contentType: z.string().optional(), perPage: z.number().int().min(1).max(100).optional(), page: z.number().int().min(1).optional(),
      destructiveConfirmation: z.string().optional(), routeContextId: z.string().uuid(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async (input) => githubRouteGuarded(runtime, key, input.routeContextId, 'github_release', input, () => runtime.github.release(input)));

  server.registerTool('github_packages', {
    title: 'GitHub Packages',
    description: routedDescription('Inspect, delete/restore versions, or run scoped npm view/publish/install operations using the dedicated GitHub Packages credential.'),
    inputSchema: {
      operation: z.enum(['list', 'get_versions', 'delete_version', 'restore_version', 'npm_view', 'npm_publish', 'npm_install']),
      packageType: z.string().optional(), packageName: z.string().optional(), versionId: z.number().int().positive().optional(),
      packageSpec: z.string().optional(), cwd: z.string().optional(), packageDir: z.string().optional(), tag: z.string().optional(),
      perPage: z.number().int().min(1).max(100).optional(), page: z.number().int().min(1).optional(), destructiveConfirmation: z.string().optional(),
      routeContextId: z.string().uuid(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async (input) => githubRouteGuarded(runtime, key, input.routeContextId, 'github_packages', input, async () => {
    if (input.operation === 'list') return runtime.github.packages.list({ packageType: requiredString(input.packageType, 'packageType'), perPage: input.perPage, page: input.page });
    if (input.operation === 'get_versions') return runtime.github.packages.getVersions({ packageType: requiredString(input.packageType, 'packageType'), packageName: requiredString(input.packageName, 'packageName'), perPage: input.perPage, page: input.page });
    if (input.operation === 'delete_version') return runtime.github.packages.deleteVersion({ packageType: requiredString(input.packageType, 'packageType'), packageName: requiredString(input.packageName, 'packageName'), versionId: requiredNumber(input.versionId, 'versionId'), destructiveConfirmation: input.destructiveConfirmation });
    if (input.operation === 'restore_version') return runtime.github.packages.restoreVersion({ packageType: requiredString(input.packageType, 'packageType'), packageName: requiredString(input.packageName, 'packageName'), versionId: requiredNumber(input.versionId, 'versionId') });
    if (input.operation === 'npm_view') return runtime.github.packages.npmView({ packageSpec: requiredString(input.packageSpec, 'packageSpec'), cwd: requiredString(input.cwd, 'cwd') });
    if (input.operation === 'npm_publish') return runtime.github.packages.npmPublish({ packageDir: requiredString(input.packageDir, 'packageDir'), tag: input.tag });
    return runtime.github.packages.npmInstall({ cwd: requiredString(input.cwd, 'cwd'), packageSpec: requiredString(input.packageSpec, 'packageSpec') });
  }));

  server.registerTool('github_api', {
    title: 'GitHub REST API',
    description: routedDescription('Call an arbitrary same-origin GitHub REST API endpoint. All non-GET calls require destructive confirmation because generic mutations cannot be classified safely.'),
    inputSchema: {
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']), endpoint: z.string().min(1), query: queryRecord.optional(),
      body: z.unknown().optional(), headers: stringRecord.optional(), credential: z.enum(['github', 'packages']).optional(),
      destructiveConfirmation: z.string().optional(), routeContextId: z.string().uuid(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async (input) => githubRouteGuarded(runtime, key, input.routeContextId, 'github_api', input, async () => {
    assertDestructiveConfirmation(input.method !== 'GET', input.destructiveConfirmation);
    const request: GitHubApiRequest = {
      method: input.method,
      endpoint: input.endpoint,
      ...(input.query ? { query: input.query } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.headers ? { headers: input.headers } : {}),
      ...(input.credential ? { credential: input.credential } : {}),
    };
    return runtime.github.apiRequest(request);
  }));
}
