import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { FileKeyStore } from '../src/auth/key-store.js';
import { loadConfig } from '../src/config.js';
import { createHttpHandler } from '../src/http/app.js';
import { FileAuditLogger } from '../src/logging/audit-log.js';
import { createMcpHttpHandler } from '../src/mcp/handler.js';
import { createRuntimeServices, type RuntimeServices } from '../src/runtime/services.js';

const roots: string[] = [];
const servers: Server[] = [];
const runtimes: RuntimeServices[] = [];

async function call(baseUrl: string, key: string, name: string, args: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 72, method: 'tools/call', params: { name, arguments: args } }),
  });
  return await response.json() as Record<string, any>;
}

function body(result: Record<string, any>): Record<string, any> {
  return JSON.parse(result.result.content[0].text) as Record<string, any>;
}

async function fixture(enforceHardGuardrails = false) {
  const root = await mkdtemp(path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), 'agent-core-op-audit-'));
  roots.push(root);
  const dbPath = path.join(root, 'runtime', 'memory', 'audit.sqlite');
  const baseMemory = loadConfig({}, root).memory;
  const runtime = createRuntimeServices([root], path.join(root, 'capabilities'), undefined, {
    ...baseMemory,
    enabled: true,
    enforceHardGuardrails,
    dbPath,
  });
  runtimes.push(runtime);
  const keyStore = new FileKeyStore(path.join(root, 'data'));
  const principal = await keyStore.create('operational-audit-principal');
  const server = createServer(createHttpHandler({
    keyStore,
    auditLogger: new FileAuditLogger(path.join(root, 'logs')),
    mcpHandler: createMcpHttpHandler(runtime),
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return {
    root,
    dbPath,
    runtime,
    principal,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    scope: { principalId: principal.metadata.id, projectId: root },
  };
}

function readEvents(dbPath: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(`SELECT event_type, source_type, source_ref, raw_text, redacted_text, metadata_json
      FROM memory_events ORDER BY created_at, rowid`).all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.memory.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('automatic operational evidence capture', () => {
  it('records routed intent/success with bounded redacted metadata while preserving the MCP result', async () => {
    const f = await fixture(false);
    const route = body(await call(f.baseUrl, f.principal.key, 'capability_route', {
      task: 'Execute one bounded PowerShell command in the project workspace.',
      context: 'Use execute_command and report its normal result.',
    }));
    const secret = 'task12-secret-bearer-token-123456789';
    const command = `Write-Output 'Authorization: Bearer ${secret}'`;
    const executed = await call(f.baseUrl, f.principal.key, 'execute_command', {
      command,
      cwd: f.root,
      routeContextId: route.routeContextId,
    });
    expect(executed.result.isError).not.toBe(true);
    const visible = body(executed);
    expect(visible.exitCode).toBe(0);
    expect(visible.stdout).toContain(secret);
    expect(Object.keys(visible).sort()).toEqual(['exitCode', 'outputTruncated', 'stderr', 'stdout', 'timedOut'].sort());

    await f.runtime.memory.close();
    const events = readEvents(f.dbPath).filter((event) => String(event.event_type).startsWith('memory.operation_'));
    expect(events.map((event) => event.event_type)).toEqual([
      'memory.operation_intended',
      'memory.operation_succeeded',
    ]);
    const persisted = JSON.stringify(events);
    const metadata = events.map((event) => JSON.parse(String(event.metadata_json)) as Record<string, any>);
    expect(persisted).not.toContain(secret);
    expect(events.every((event) => event.raw_text === null)).toBe(true);
    expect(metadata.every((event) => event.toolName === 'execute_command')).toBe(true);
    expect(metadata.some((event) => Array.isArray(event.affectedPaths) && event.affectedPaths.includes(f.root))).toBe(true);
    expect(metadata.some((event) => event.verification?.required === true)).toBe(true);
    expect(metadata[1]!.result.stdout).toBeUndefined();
    expect(metadata[1]!.result.stdoutBytes).toBeGreaterThan(0);
  });

  it('records execution failures and hard-route rejections as recallable failure evidence without side effects', async () => {
    const f = await fixture(true);
    const missing = path.join(f.root, 'missing-proof.txt');
    const readRoute = body(await call(f.baseUrl, f.principal.key, 'capability_route', {
      task: `Read the missing file ${missing}`,
      context: 'Use read_file.',
    }));
    const failedRead = await call(f.baseUrl, f.principal.key, 'read_file', {
      path: missing,
      routeContextId: readRoute.routeContextId,
    });
    expect(failedRead.result.isError).toBe(true);

    const recalledFailure = await f.runtime.memory.search({
      scope: f.scope,
      query: `read_file ${missing}`,
      limit: 10,
    });
    expect(recalledFailure.hits.some((hit) => hit.kind === 'failure' && hit.valueText.includes('read_file'))).toBe(true);

    const target = path.join(f.root, 'blocked-proof.txt');
    const guardrail = await f.runtime.memory.commit({
      scope: f.scope,
      canonicalKey: 'guardrail.task12.blocked-proof',
      kind: 'guardrail',
      value: `Do not create ${target}.`,
      enforcement: 'hard',
      pinned: true,
      importance: 1,
      sourceType: 'test',
    });
    const blockedRoute = body(await call(f.baseUrl, f.principal.key, 'capability_route', {
      task: `Create ${target}`,
      context: 'Use write_file.',
    }));
    expect(blockedRoute.blockingGuardrails.map((item: any) => item.memoryId)).toContain(guardrail.memoryId);
    const blockedWrite = await call(f.baseUrl, f.principal.key, 'write_file', {
      path: target,
      content: 'should never exist',
      routeContextId: blockedRoute.routeContextId,
    });
    expect(blockedWrite.result.isError).toBe(true);
    expect(body(blockedWrite).error.code).toBe('ROUTE_MEMORY_GUARDRAIL_BLOCKED');
    await expect(access(target)).rejects.toThrow();

    const rejectedFailure = await f.runtime.memory.search({
      scope: f.scope,
      query: `write_file ${target} ROUTE_MEMORY_GUARDRAIL_BLOCKED`,
      limit: 10,
    });
    expect(rejectedFailure.hits.some((hit) => hit.kind === 'failure' && hit.valueText.includes('ROUTE_MEMORY_GUARDRAIL_BLOCKED'))).toBe(true);

    await f.runtime.memory.close();
    const operationTypes = readEvents(f.dbPath)
      .map((event) => String(event.event_type))
      .filter((eventType) => eventType.startsWith('memory.operation_'));
    expect(operationTypes).toContain('memory.operation_failed');
    expect(operationTypes).toContain('memory.operation_rejected');
  });
});
