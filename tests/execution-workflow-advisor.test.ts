import { describe, expect, it } from 'vitest';
import { WorkflowAdvisor } from '../src/mcp/workflow-advisor.js';

function baseView(overrides: Record<string, any> = {}) {
  return {
    runId: '11111111-1111-4111-8111-111111111111',
    state: 'planned', objective: 'fixture', maxConcurrency: 4, lastEventSequence: 7,
    principalId: 'principal', projectId: '/project', metadata: {}, createdAt: 1, updatedAt: 1,
    nodes: [
      { runId: 'r', nodeId: 'A', purpose: 'A', command: 'a', cwd: '/project', state: 'queued', timeoutMs: 1, continueOnFailure: false, expectedArtifacts: [], attemptCount: 0, dependsOn: [], createdAt: 1, updatedAt: 1 },
      { runId: 'r', nodeId: 'B', purpose: 'B', command: 'b', cwd: '/project', state: 'queued', timeoutMs: 1, continueOnFailure: false, expectedArtifacts: [], attemptCount: 0, dependsOn: [], createdAt: 1, updatedAt: 1 },
    ],
    evidence: {
      verification: 'pending',
      nodes: [
        { nodeId: 'A', attemptNo: null, resultVersion: null, processState: 'queued', evidenceState: 'pending', stdoutBytes: 0, stderrBytes: 0, stdoutSha256: null, stderrSha256: null, artifacts: [] },
        { nodeId: 'B', attemptNo: null, resultVersion: null, processState: 'queued', evidenceState: 'pending', stdoutBytes: 0, stderrBytes: 0, stdoutSha256: null, stderrSha256: null, artifacts: [] },
      ],
    },
    ...overrides,
  } as any;
}

function runtime(options: { executionHealthy?: boolean; memoryHealthy?: boolean; reuse?: any } = {}) {
  const calls = { start: 0 };
  return {
    calls,
    execution: {
      config: { enabled: true },
      currentState: options.executionHealthy === false ? 'degraded' : 'healthy',
      artifacts: { findReusable: async () => options.reuse ?? { found: false, advisoryOnly: true } },
    },
    memory: {
      config: { enabled: true },
      currentState: options.memoryHealthy === false ? 'degraded' : 'healthy',
    },
  } as any;
}

describe('deterministic multi-command workflow advisor', () => {
  it('recommends routed parallel dispatch for independent ready nodes and is deterministic', async () => {
    const rt = runtime();
    const advisor = new WorkflowAdvisor(rt);
    const input = { scope: { principalId: 'principal', projectId: '/project' }, routeContextId: 'route-a', availableTools: ['execution_start', 'execution_wait'] };
    const first = await advisor.analyzeRun(baseView(), input);
    const second = await advisor.analyzeRun(baseView(), input);
    expect(second).toEqual(first);
    expect(first[0]).toMatchObject({
      category: 'parallelization', actionable: true,
      proposedNext: { tool: 'execution_start', args: { routeContextId: 'route-a', runId: '11111111-1111-4111-8111-111111111111' } },
      reasonCodes: ['independent_ready_nodes'], sourceNodeIds: ['A', 'B'], sourceEventSequence: 7,
    });
  });

  it('uses bounded event-driven timing advice for running nodes without inventing semantic work', async () => {
    const view = baseView({
      state: 'running',
      nodes: [{ ...baseView().nodes[0], state: 'running' }],
      evidence: { verification: 'pending', nodes: [{ ...baseView().evidence.nodes[0], processState: 'running' }] },
    });
    const advice = await new WorkflowAdvisor(runtime()).analyzeRun(view, {
      scope: { principalId: 'principal', projectId: '/project' }, availableTools: ['execution_wait'],
    });
    expect(advice).toEqual([expect.objectContaining({
      category: 'timing', actionable: true, reasonCodes: ['running_nodes_event_wait'],
      proposedNext: { tool: 'execution_wait', args: { runId: view.runId, afterSequence: 7, timeoutMs: 60000 } },
    })]);
    expect(JSON.stringify(advice)).not.toMatch(/review test coverage|do useful work/i);
  });

  it('prioritizes factual evidence failures and parsed test failures without raw-log leakage', async () => {
    const view = baseView({
      state: 'failed',
      nodes: [{ ...baseView().nodes[0], state: 'failed', attemptCount: 1 }],
      evidence: { verification: 'failed', nodes: [{
        ...baseView().evidence.nodes[0], attemptNo: 1, processState: 'failed', evidenceState: 'failed',
        parsedOutput: { available: true, status: 'available', parserVersion: '1.0.0', confidence: 0.95, source: { stdoutSha256: 'a'.repeat(64), stderrSha256: 'b'.repeat(64) }, structured: { testResults: { passed: 3, failed: 2, skipped: 0 } } },
      }] },
    });
    const advice = await new WorkflowAdvisor(runtime()).analyzeRun(view, {
      scope: { principalId: 'principal', projectId: '/project' }, availableTools: ['execution_logs'],
    });
    expect(advice[0]).toMatchObject({ category: 'evidence', reasonCodes: expect.arrayContaining(['evidence_failed']) });
    expect(advice.some((item: any) => item.reasonCodes.includes('parsed_test_failures'))).toBe(true);
    expect(JSON.stringify(advice)).not.toContain('command');
  });

  it('treats factual process failure as evidence requiring inspection even when no artifact was declared', async () => {
    const view = baseView({
      state: 'failed',
      nodes: [{ ...baseView().nodes[0], state: 'failed', attemptCount: 1 }],
      evidence: { verification: 'verified', nodes: [{
        ...baseView().evidence.nodes[0], attemptNo: 1, processState: 'failed', evidenceState: 'not_declared',
      }] },
    });
    const advice = await new WorkflowAdvisor(runtime()).analyzeRun(view, {
      scope: { principalId: 'principal', projectId: '/project' }, availableTools: ['execution_logs'],
    });
    expect(advice[0]).toMatchObject({
      category: 'evidence',
      reasonCodes: expect.arrayContaining(['process_failed']),
      proposedNext: { tool: 'execution_logs', args: expect.objectContaining({ nodeId: 'A', attemptNo: 1 }) },
    });
  });

  it('surfaces verified reuse only as advisory optimization and never proposes command skipping', async () => {
    const view = baseView({
      state: 'completed',
      nodes: [{ ...baseView().nodes[0], state: 'succeeded', attemptCount: 1 }],
      evidence: { verification: 'verified', nodes: [{
        ...baseView().evidence.nodes[0], attemptNo: 1, processState: 'succeeded', evidenceState: 'verified',
        artifacts: [{ path: '/project/a.bin', kind: 'file', artifactType: 'build', required: true, exists: true, verification: 'verified', sha256: 'c'.repeat(64) }],
      }] },
    });
    const reuse = { found: true, advisoryOnly: true, stillExists: true, stillVerified: true, artifact: { artifactId: 'artifact-old', runId: 'old-run', path: '/project/old.bin', sha256: 'c'.repeat(64) } };
    const advice = await new WorkflowAdvisor(runtime({ reuse })).analyzeRun(view, {
      scope: { principalId: 'principal', projectId: '/project' }, availableTools: [],
    });
    const cache = advice.find((item: any) => item.reasonCodes.includes('verified_reuse_candidate'));
    expect(cache).toMatchObject({ category: 'optimization', actionable: false });
    expect(cache?.proposedNext).toBeUndefined();
    expect(JSON.stringify(cache)).not.toMatch(/skip|bypass|cancel/i);
  });

  it('suppresses increased parallelism when local memory/execution health is degraded', async () => {
    const advice = await new WorkflowAdvisor(runtime({ executionHealthy: false })).analyzeRun(baseView(), {
      scope: { principalId: 'principal', projectId: '/project' }, routeContextId: 'route-a', availableTools: ['execution_start'],
    });
    expect(advice.some((item: any) => item.category === 'parallelization')).toBe(false);
    expect(advice[0]).toMatchObject({ category: 'optimization', actionable: false, reasonCodes: ['local_health_degraded'] });
  });
});
