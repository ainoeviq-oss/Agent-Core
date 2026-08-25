import { createHash } from 'node:crypto';
import type { VerifiedKey } from '../auth/key-types.js';
import type { RouteContext } from '../runtime/route-context-store.js';
import type { RuntimeServices } from '../runtime/services.js';
import { redactMemoryText } from './redaction.js';

const MAX_PREVIEW_CHARS = 1000;
const MAX_PATHS = 50;
const MAX_PATH_CHARS = 2048;

function boundedString(value: string, maxChars = MAX_PREVIEW_CHARS): string {
  const sliced = value.slice(0, maxChars);
  return redactMemoryText(sliced).text;
}

function pathList(input: Record<string, unknown>): string[] {
  const values: string[] = [];
  const push = (value: unknown) => {
    if (typeof value !== 'string' || values.length >= MAX_PATHS) return;
    values.push(value.slice(0, MAX_PATH_CHARS));
  };
  push(input.path);
  if (Array.isArray(input.paths)) for (const value of input.paths) push(value);
  push(input.source);
  push(input.destination);
  push(input.cwd);
  return [...new Set(values)];
}

function safeScalar(value: unknown): string | number | boolean | null | undefined {
  if (typeof value === 'string') return boundedString(value);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean' || value === null) return value;
  return undefined;
}

export function summarizeOperationalInput(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = { toolName };
  const allowed = [
    'path', 'source', 'destination', 'cwd', 'depth', 'maxEntries', 'startLine', 'lineCount', 'maxBytes',
    'mode', 'expectedReplacements', 'query', 'maxResults', 'timeoutMs', 'contentBytes', 'oldStringBytes',
    'newStringBytes',
  ];
  for (const key of allowed) {
    const value = safeScalar(input[key]);
    if (value !== undefined) summary[key] = value;
  }
  if (Array.isArray(input.paths)) {
    summary.paths = input.paths.slice(0, MAX_PATHS).filter((value): value is string => typeof value === 'string')
      .map((value) => value.slice(0, MAX_PATH_CHARS));
  }
  if (typeof input.command === 'string') {
    summary.commandPreview = boundedString(input.command);
    summary.commandBytes = Buffer.byteLength(input.command, 'utf8');
  }
  return summary;
}

export function summarizeOperationalResult(result: unknown): Record<string, unknown> {
  if (result === null || result === undefined) return { resultType: String(result) };
  if (typeof result !== 'object') return { resultType: typeof result };
  const record = result as Record<string, unknown>;
  const summary: Record<string, unknown> = {
    resultType: Array.isArray(result) ? 'array' : 'object',
    resultKeys: Object.keys(record).sort().slice(0, 64),
  };
  const safeKeys = [
    'path', 'mode', 'bytes', 'replacements', 'source', 'destination', 'created', 'exitCode', 'timedOut',
    'outputTruncated', 'sessionId', 'pid', 'running', 'truncated', 'count', 'total',
  ];
  for (const key of safeKeys) {
    const value = safeScalar(record[key]);
    if (value !== undefined) summary[key] = value;
  }
  if (Array.isArray(result)) summary.itemCount = result.length;
  for (const key of ['content', 'stdout', 'stderr', 'text', 'data', 'instructions']) {
    if (key in record) {
      const value = record[key];
      if (typeof value === 'string') summary[`${key}Bytes`] = Buffer.byteLength(value, 'utf8');
      else if (Array.isArray(value)) summary[`${key}Count`] = value.length;
    }
  }
  return summary;
}

function errorSummary(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const code = 'code' in error && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : error.name;
    return { code, name: error.name, message: boundedString(error.message, 2000) };
  }
  return { code: 'ERROR', message: boundedString(String(error), 2000) };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`;
}

function verification(route: RouteContext | undefined) {
  if (!route) return { state: 'unknown', required: false, suggestedTools: [] as string[] };
  return {
    state: route.verification.required ? 'required_pending' : 'not_required',
    required: route.verification.required,
    suggestedTools: [...route.verification.suggestedTools],
  };
}

export class OperationalMemoryAudit {
  constructor(
    readonly runtime: RuntimeServices,
    readonly key: VerifiedKey,
  ) {}

  async intended(route: RouteContext, toolName: string, input: Record<string, unknown>): Promise<void> {
    const summary = summarizeOperationalInput(toolName, input);
    await this.safeRecord('memory.operation_intended', route.routeContextId, toolName, {
      input: summary,
      affectedPaths: pathList(input),
      verification: verification(route),
    });
  }

  async succeeded(
    route: RouteContext,
    toolName: string,
    input: Record<string, unknown>,
    result: unknown,
  ): Promise<void> {
    await this.safeRecord('memory.operation_succeeded', route.routeContextId, toolName, {
      input: summarizeOperationalInput(toolName, input),
      result: summarizeOperationalResult(result),
      affectedPaths: pathList(input),
      verification: verification(route),
    });
  }

  async failed(
    route: RouteContext,
    toolName: string,
    input: Record<string, unknown>,
    error: unknown,
  ): Promise<void> {
    const errorValue = errorSummary(error);
    const inputSummary = summarizeOperationalInput(toolName, input);
    const affectedPaths = pathList(input);
    await this.safeRecord('memory.operation_failed', route.routeContextId, toolName, {
      input: inputSummary,
      error: errorValue,
      affectedPaths,
      verification: verification(route),
    });
    await this.safeFailureMemory(route.routeContextId, toolName, inputSummary, affectedPaths, errorValue);
  }

  async rejected(
    routeContextId: string,
    toolName: string,
    input: Record<string, unknown>,
    error: unknown,
  ): Promise<void> {
    const errorValue = errorSummary(error);
    const inputSummary = summarizeOperationalInput(toolName, input);
    const affectedPaths = pathList(input);
    await this.safeRecord('memory.operation_rejected', routeContextId, toolName, {
      input: inputSummary,
      error: errorValue,
      affectedPaths,
      verification: verification(undefined),
    });
    await this.safeFailureMemory(routeContextId, toolName, inputSummary, affectedPaths, errorValue);
  }

  private scope() {
    return {
      principalId: this.key.id,
      projectId: this.runtime.workspace.roots[0],
    };
  }

  private async safeRecord(
    eventType: string,
    routeContextId: string,
    toolName: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.runtime.memory.recordEvent({
        scope: this.scope(),
        eventType,
        sourceType: 'operational_audit',
        sourceRef: routeContextId,
        text: `${toolName} ${eventType.replace('memory.operation_', '')}`,
        metadata: { routeContextId, toolName, ...metadata },
      });
    } catch {
      // Operational audit is deliberately best-effort and must never mutate tool behavior.
    }
  }

  private async safeFailureMemory(
    routeContextId: string,
    toolName: string,
    input: Record<string, unknown>,
    affectedPaths: string[],
    error: Record<string, unknown>,
  ): Promise<void> {
    try {
      const signature = stableJson({ toolName, input, affectedPaths });
      const signatureHash = createHash('sha256').update(signature, 'utf8').digest('hex').slice(0, 24);
      await this.runtime.memory.commit({
        scope: this.scope(),
        canonicalKey: `failure.operation.${toolName}.${signatureHash}`,
        kind: 'failure',
        value: {
          toolName,
          status: 'failure',
          error,
          affectedPaths,
          input,
        },
        importance: 0.85,
        sourceType: 'operational_audit',
        sourceRef: routeContextId,
        revisionAuthority: 'structured_state',
      });
    } catch {
      // Failure evidence must never become a second failure path for the operational tool.
    }
  }
}
