import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { FileKeyStore } from '../src/auth/key-store.js';
import { loadConfig } from '../src/config.js';
import { createHttpHandler } from '../src/http/app.js';
import { FileAuditLogger } from '../src/logging/audit-log.js';
import { createMcpHttpHandler } from '../src/mcp/handler.js';
import { createRuntimeServices, type RuntimeServices } from '../src/runtime/services.js';
import { nodeShellCommand, printCommand } from './helpers/platform-command.js';

const roots: string[] = [];
const servers: Server[] = [];
const runtimes: RuntimeServices[] = [];

async function fixture(label: string) {
  const root = await mkdtemp(path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), `agent-core-continuity-checkpoint-${label}-`));
  roots.push(root);
  const memory = loadConfig({}, root).memory;
  const runtime = createRuntimeServices([root], path.join(root, 'capabilities'), undefined, {
    ...memory,
    enabled: true,
    dbPath: path.join(root, 'runtime', 'memory', 'checkpoint.sqlite'),
  });
  runtimes.push(runtime);
  const keyStore = new FileKeyStore(path.join(root, 'data'));
  const principalA = await keyStore.create(`checkpoint-a-${label}`);
  const principalB = await keyStore.create(`checkpoint-b-${label}`);
  const app = createHttpHandler({
    keyStore,
    auditLogger: new FileAuditLogger(path.join(root, 'logs')),
    mcpHandler: createMcpHttpHandler(runtime),
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return {
    root,
    runtime,
    principalA,
    principalB,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    scopeA: { principalId: principalA.metadata.id, projectId: root },
  };
}

async function call(baseUrl: string, key: string, name: string, args: Record<string, unknown> = {}) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 81, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await response.json() as Record<string, any>;
  const text = String(raw.result.content[0].text);
  let result: Record<string, any>;
  try {
    result = JSON.parse(text) as Record<string, any>;
  } catch {
    result = { error: { code: 'MCP_ERROR', message: text } };
  }
  return { raw, result };
}

async function listTools(baseUrl: string, key: string) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 82, method: 'tools/list', params: {} }),
  });
  return await response.json() as Record<string, any>;
}

async function route(f: Awaited<ReturnType<typeof fixture>>, objective: string) {
  const routed = await call(f.baseUrl, f.principalA.key, 'capability_route', {
    task: objective,
    continuity: { objective },
  });
  expect(routed.raw.result.isError).not.toBe(true);
  expect(routed.result.continuityStatus).toBe('healthy');
  return routed.result;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(runtimes.splice(0).map(async (runtime) => {
    await runtime.execution.close().catch(() => undefined);
    await runtime.memory.close().catch(() => undefined);
  }));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('continuity checkpoint MCP tools', () => {
  it('registers four first-class continuity tools inside the 55-tool surface with execution fabric', async () => {
    const f = await fixture('surface');
    const listed = await listTools(f.baseUrl, f.principalA.key);
    const names = listed.result.tools.map((tool: any) => tool.name);
    expect(names).toHaveLength(55);
    for (const name of ['task_checkpoint', 'continuity_status', 'continuity_get_task', 'continuity_frontier']) {
      expect(names).toContain(name);
    }
  });

  it('rejects terminal checkpoint without required frontier and leaves the task + turn unchanged', async () => {
    const f = await fixture('invalid-terminal');
    const routed = await route(f, 'Checkpoint validation task');

    const invalid = await call(f.baseUrl, f.principalA.key, 'task_checkpoint', {
      routeContextId: routed.routeContextId,
      status: 'completed',
      summary: 'Completed but missing frontier.',
    });
    expect(invalid.raw.result.isError).toBe(true);
    expect(invalid.result.error.code).toBe('CONTINUITY_FRONTIER_REQUIRED');

    const task = await f.runtime.memory.getContinuityTask(f.scopeA, routed.continuityTaskId);
    expect(task?.status).toBe('running');
    const db = new DatabaseSync(f.runtime.memory.config.dbPath, { readOnly: true });
    try {
      const turn = db.prepare('SELECT state FROM continuity_turns WHERE id = ?').get(routed.continuityTurnId) as any;
      expect(turn.state).toBe('open');
      expect(Number((db.prepare('SELECT count(*) AS count FROM continuity_checkpoints').get() as any).count)).toBe(0);
      expect(Number((db.prepare('SELECT count(*) AS count FROM continuity_frontier').get() as any).count)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('persists terminal evidence/frontier, promotes decision+artifact memories, and closes the turn only after checkpoint success', async () => {
    const f = await fixture('complete');
    const routed = await route(f, 'Complete checkpoint task');

    const completed = await call(f.baseUrl, f.principalA.key, 'task_checkpoint', {
      routeContextId: routed.routeContextId,
      status: 'completed',
      summary: 'Task completed with verified evidence.',
      evidence: [
        { type: 'test', ref: 'tests/example.test.ts', result: 'PASS' },
        { type: 'hash', ref: 'artifact.sha256', result: 'abc123' },
      ],
      decisions: [{ key: 'execution.mode', value: 'deterministic', reason: 'Evidence must be reproducible.' }],
      artifacts: [{ path: 'F:\\Projects\\Agent-Core\\docs\\result.md', role: 'result', hash: 'abc123' }],
      outcomes: [{
        key: 'build.result',
        value: 'Build verified locally with factual evidence.',
        evidenceRefs: ['tests/example.test.ts', 'artifact.sha256'],
      }],
      constraints: [{
        key: 'release.ci',
        value: 'Never use GitHub Actions or CI for this project.',
        reason: 'Local verification is authoritative.',
        enforcement: 'hard',
      }],
      deferred: [{ title: 'Later enhancement', reason: 'Outside current task.' }],
      nextCandidates: [
        { title: 'Candidate A', rationale: 'Next independent step.', priority: 2 },
        { title: 'Candidate B', rationale: 'Alternative next step.', priority: 1 },
      ],
    });
    expect(completed.raw.result.isError).not.toBe(true);
    expect(completed.result.taskStatus).toBe('completed');
    expect(completed.result.turnState).toBe('closed');
    expect(completed.result.promoted).toMatchObject({
      decisions: 1, artifacts: 1, outcomes: 1, constraints: 1, failures: 0,
    });

    const task = await f.runtime.memory.getContinuityTask(f.scopeA, routed.continuityTaskId);
    expect(task?.status).toBe('completed');
    const frontierTool = await call(f.baseUrl, f.principalA.key, 'continuity_frontier', { limit: 5 });
    expect(frontierTool.result.map((item: any) => item.title)).toEqual(['Candidate A', 'Candidate B']);
    const getTask = await call(f.baseUrl, f.principalA.key, 'continuity_get_task', { taskId: routed.continuityTaskId });
    expect(getTask.result.taskId).toBe(routed.continuityTaskId);
    expect(getTask.result.status).toBe('completed');

    const db = new DatabaseSync(f.runtime.memory.config.dbPath, { readOnly: true });
    try {
      const turn = db.prepare('SELECT state FROM continuity_turns WHERE id = ?').get(routed.continuityTurnId) as any;
      expect(turn.state).toBe('closed');
      const kinds = (db.prepare(`SELECT kind FROM memory_items
        WHERE principal_id = ? AND IFNULL(project_id, '') = ?
        ORDER BY kind`).all(f.scopeA.principalId, f.root) as Array<{ kind: string }>).map((row) => row.kind);
      expect(kinds).toContain('decision');
      expect(kinds).toContain('artifact');
      expect(kinds).toContain('project_state');
      expect(kinds).toContain('guardrail');
      const checkpoint = db.prepare('SELECT summary_json, evidence_json FROM continuity_checkpoints WHERE id = ?')
        .get(completed.result.checkpointId) as any;
      expect(checkpoint.summary_json).toContain('Later enhancement');
      expect(checkpoint.evidence_json).toContain('tests/example.test.ts');
    } finally {
      db.close();
    }
  });

  it('does not promote generic successful summary prose without explicit structured outcome facts', async () => {
    const f = await fixture('no-summary-spam');
    const routed = await route(f, 'Generic summary should stay in continuity only');
    const completed = await call(f.baseUrl, f.principalA.key, 'task_checkpoint', {
      routeContextId: routed.routeContextId,
      status: 'completed',
      summary: 'This prose is useful for continuity but is not an explicit durable memory fact.',
      projectTerminal: true,
    });
    expect(completed.raw.result.isError).not.toBe(true);
    expect(completed.result.promoted).toMatchObject({
      decisions: 0, artifacts: 0, outcomes: 0, constraints: 0, failures: 0,
    });

    const db = new DatabaseSync(f.runtime.memory.config.dbPath, { readOnly: true });
    try {
      const items = db.prepare(`SELECT count(*) AS count FROM memory_items
        WHERE principal_id = ? AND IFNULL(project_id, '') = ?`)
        .get(f.scopeA.principalId, f.root) as any;
      expect(Number(items.count)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('requires explicit verified execution evidence before completing an execution-backed continuity task', async () => {
    const f = await fixture('execution-completion-gate');
    const routed = await route(f, 'Execution-backed completion gate task');
    await f.runtime.execution.open();

    const artifactPath = path.join(f.root, 'verified-output.json');
    const verifiedRun = await f.runtime.execution.create(f.scopeA, {
      objective: 'Produce verified completion evidence',
      continuityTaskId: routed.continuityTaskId,
      originRouteContextId: routed.routeContextId,
      nodes: [{
        id: 'A',
        purpose: 'produce verified artifact',
        command: nodeShellCommand(`require('node:fs').writeFileSync(${JSON.stringify(artifactPath)}, '{"ok":true}')`),
        cwd: f.root,
        expectedArtifacts: [{ path: artifactPath, kind: 'file', hash: 'sha256', required: true }],
      }],
    });
    await f.runtime.execution.start(f.scopeA, verifiedRun.runId);
    const verifiedDone = await f.runtime.execution.wait(
      f.scopeA, verifiedRun.runId, verifiedRun.lastEventSequence, { eventTypes: ['run.completed'] }, 5_000,
    );
    expect(verifiedDone.state.evidence.verification).toBe('verified');

    const missingRef = await call(f.baseUrl, f.principalA.key, 'task_checkpoint', {
      routeContextId: routed.routeContextId,
      status: 'completed',
      summary: 'Must not complete without an explicit execution evidence reference.',
      projectTerminal: true,
    });
    expect(missingRef.raw.result.isError).toBe(true);
    expect(missingRef.result.error.code).toBe('CONTINUITY_EXECUTION_EVIDENCE_REQUIRED');
    expect((await f.runtime.memory.getContinuityTask(f.scopeA, routed.continuityTaskId))?.status).toBe('running');

    const completed = await call(f.baseUrl, f.principalA.key, 'task_checkpoint', {
      routeContextId: routed.routeContextId,
      status: 'completed',
      summary: 'Completion is backed by the exact verified execution run.',
      evidence: [{ type: 'tool', ref: `execution:${verifiedRun.runId}`, result: 'verified' }],
      projectTerminal: true,
    });
    expect(completed.raw.result.isError).not.toBe(true);
    expect(completed.result.taskStatus).toBe('completed');
  }, 10_000);

  it('rejects execution-backed completion when an explicitly referenced run failed required artifact evidence', async () => {
    const f = await fixture('execution-completion-failed-evidence');
    const routed = await route(f, 'Failed execution evidence completion gate');
    await f.runtime.execution.open();
    const failedRun = await f.runtime.execution.create(f.scopeA, {
      objective: 'Exit zero but fail required artifact evidence',
      continuityTaskId: routed.continuityTaskId,
      originRouteContextId: routed.routeContextId,
      nodes: [{
        id: 'A', purpose: 'omit required artifact', command: printCommand('process-success'), cwd: f.root,
        expectedArtifacts: [{ path: path.join(f.root, 'missing-required.txt'), kind: 'file', required: true }],
      }],
    });
    await f.runtime.execution.start(f.scopeA, failedRun.runId);
    const failedDone = await f.runtime.execution.wait(
      f.scopeA, failedRun.runId, failedRun.lastEventSequence, { eventTypes: ['run.failed'] }, 5_000,
    );
    expect(failedDone.state.state).toBe('failed');
    expect(failedDone.state.evidence.verification).toBe('failed');

    const denied = await call(f.baseUrl, f.principalA.key, 'task_checkpoint', {
      routeContextId: routed.routeContextId,
      status: 'completed',
      summary: 'Must not contradict failed required execution evidence.',
      evidence: [{ type: 'tool', ref: `execution:${failedRun.runId}`, result: 'verified' }],
      projectTerminal: true,
    });
    expect(denied.raw.result.isError).toBe(true);
    expect(denied.result.error.code).toBe('CONTINUITY_EXECUTION_EVIDENCE_INVALID');
    expect((await f.runtime.memory.getContinuityTask(f.scopeA, routed.continuityTaskId))?.status).toBe('running');
  }, 10_000);

  it('blocks semantic completion while a linked execution run is still planned or running', async () => {
    const f = await fixture('execution-completion-active');
    const routed = await route(f, 'Active execution completion gate');
    await f.runtime.execution.open();
    const activeRun = await f.runtime.execution.create(f.scopeA, {
      objective: 'Still planned',
      continuityTaskId: routed.continuityTaskId,
      originRouteContextId: routed.routeContextId,
      nodes: [{ id: 'A', purpose: 'planned work', command: printCommand('A'), cwd: f.root }],
    });
    const denied = await call(f.baseUrl, f.principalA.key, 'task_checkpoint', {
      routeContextId: routed.routeContextId,
      status: 'completed',
      summary: 'Cannot complete while execution remains active.',
      evidence: [{ type: 'tool', ref: `execution:${activeRun.runId}`, result: 'verified' }],
      projectTerminal: true,
    });
    expect(denied.raw.result.isError).toBe(true);
    expect(denied.result.error.code).toBe('CONTINUITY_EXECUTION_ACTIVE');
  });

  it('promotes a failed terminal checkpoint into failure memory and preserves next frontier', async () => {
    const f = await fixture('failed');
    const routed = await route(f, 'Failure promotion task');
    const failed = await call(f.baseUrl, f.principalA.key, 'task_checkpoint', {
      routeContextId: routed.routeContextId,
      status: 'failed',
      summary: 'Build failed due to deterministic fixture error.',
      blockers: [{ code: 'BUILD_FAILED', detail: 'Compiler returned exit 1.' }],
      evidence: [{ type: 'log', ref: 'build.stderr.log', result: 'exit=1' }],
      nextCandidates: [
        { title: 'Inspect compiler error', rationale: 'Root-cause the failure.' },
        { title: 'Retry after repair', rationale: 'Run only after diagnosis.' },
      ],
    });
    expect(failed.raw.result.isError).not.toBe(true);
    expect(failed.result.promoted.failures).toBe(1);
    expect(failed.result.turnState).toBe('closed');

    const db = new DatabaseSync(f.runtime.memory.config.dbPath, { readOnly: true });
    try {
      const failures = db.prepare(`SELECT count(*) AS count FROM memory_items
        WHERE principal_id = ? AND IFNULL(project_id, '') = ? AND kind = 'failure'`)
        .get(f.scopeA.principalId, f.root) as any;
      expect(Number(failures.count)).toBe(1);
    } finally {
      db.close();
    }
  });

  it('keeps non-terminal turns open, marks an interrupted checkpoint resumable, and blocks cross-principal finalization', async () => {
    const f = await fixture('nonterminal');
    const runningRoute = await route(f, 'Non-terminal checkpoint task');
    const running = await call(f.baseUrl, f.principalA.key, 'task_checkpoint', {
      routeContextId: runningRoute.routeContextId,
      status: 'running',
      summary: 'Work is still in progress.',
      evidence: [{ type: 'test', ref: 'partial.test.ts', result: 'PASS' }],
    });
    expect(running.raw.result.isError).not.toBe(true);
    expect(running.result.turnState).toBe('open');

    const denied = await call(f.baseUrl, f.principalB.key, 'task_checkpoint', {
      routeContextId: runningRoute.routeContextId,
      status: 'completed',
      summary: 'Principal B must not finalize this.',
      projectTerminal: true,
    });
    expect(denied.raw.result.isError).toBe(true);
    expect(denied.result.error.code).toBe('ROUTE_PRINCIPAL_MISMATCH');

    const interruptedRoute = await route(f, 'Interruptible checkpoint task');
    const interrupted = await call(f.baseUrl, f.principalA.key, 'task_checkpoint', {
      routeContextId: interruptedRoute.routeContextId,
      status: 'interrupted',
      summary: 'Session is ending before completion.',
    });
    expect(interrupted.raw.result.isError).not.toBe(true);
    expect(interrupted.result.turnState).toBe('interrupted');
    const status = await call(f.baseUrl, f.principalA.key, 'continuity_status');
    expect(status.result.snapshot.unfinishedPlans.map((item: any) => item.taskId))
      .toContain(interruptedRoute.continuityTaskId);
    expect(status.result.snapshot.interruptedTurns.map((item: any) => item.turnId))
      .toContain(interruptedRoute.continuityTurnId);
  });
});
