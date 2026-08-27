import type { ExecutionRunView } from '../execution/service.js';
import type { ExecutionScope } from '../execution/types.js';
import type { RuntimeServices } from '../runtime/services.js';

export type WorkflowGuidanceCategory = 'parallelization' | 'evidence' | 'timing' | 'optimization';

export interface WorkflowGuidance {
  suggestion: string;
  category: WorkflowGuidanceCategory;
  actionable: boolean;
  proposedNext?: { tool: string; args: Record<string, unknown> };
  reasonCodes: string[];
  sourceNodeIds: string[];
  sourceEventSequence: number;
  evidenceRefs: string[];
}

export interface WorkflowAdvisorContext {
  scope: ExecutionScope;
  routeContextId?: string;
  availableTools: string[];
  includeCacheValidation?: boolean;
}

function readyNodes(view: ExecutionRunView): string[] {
  const byId = new Map(view.nodes.map((node) => [node.nodeId, node]));
  return view.nodes
    .filter((node) => (node.state === 'queued' || node.state === 'ready')
      && node.dependsOn.every((dependencyId) => byId.get(dependencyId)?.state === 'succeeded'))
    .map((node) => node.nodeId)
    .sort((left, right) => left.localeCompare(right));
}

function evidenceRef(view: ExecutionRunView, nodeId: string): string {
  return `execution:${view.runId}:node:${nodeId}`;
}

export class WorkflowAdvisor {
  constructor(private readonly runtime: Pick<RuntimeServices, 'execution' | 'memory'>) {}

  async analyzeRun(view: ExecutionRunView, context: WorkflowAdvisorContext): Promise<WorkflowGuidance[]> {
    const tools = new Set(context.availableTools);
    const advice: WorkflowGuidance[] = [];
    const executionState = this.runtime.execution.currentState;
    const memoryState = this.runtime.memory.currentState;
    const executionEnabled = this.runtime.execution.config?.enabled !== false;
    const memoryEnabled = this.runtime.memory.config?.enabled !== false;
    const executionHealthy = !executionEnabled || executionState === undefined || executionState === 'healthy';
    const memoryHealthy = !memoryEnabled || memoryState === undefined || memoryState === 'healthy' || memoryState === 'disabled';
    const locallyHealthy = Boolean(executionHealthy && memoryHealthy);

    if (!locallyHealthy) {
      advice.push({
        suggestion: 'Local memory or execution health is degraded; keep workload conservative and inspect factual health before increasing parallel work.',
        category: 'optimization',
        actionable: false,
        reasonCodes: ['local_health_degraded'],
        sourceNodeIds: [],
        sourceEventSequence: view.lastEventSequence,
        evidenceRefs: [`execution:${view.runId}`, 'health:local'],
      });
    }

    const failedEvidence = view.evidence.nodes
      .filter((node) => node.evidenceState === 'failed' || node.processState === 'failed')
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
    if (failedEvidence.length > 0) {
      const nodeIds = failedEvidence.map((node) => node.nodeId);
      const first = failedEvidence[0]!;
      const reasonCodes = [
        ...(failedEvidence.some((node) => node.evidenceState === 'failed') ? ['evidence_failed'] : []),
        ...(failedEvidence.some((node) => node.processState === 'failed') ? ['process_failed'] : []),
      ];
      const proposedNext = tools.has('execution_logs') && first.attemptNo
        ? { tool: 'execution_logs', args: { runId: view.runId, nodeId: first.nodeId, attemptNo: first.attemptNo, stream: 'stderr', offset: 0, maxBytes: 65536 } }
        : undefined;
      advice.push({
        suggestion: `${failedEvidence.length} node(s) have failed evidence; inspect persisted evidence before any retry or completion claim.`,
        category: 'evidence',
        actionable: Boolean(proposedNext),
        ...(proposedNext ? { proposedNext } : {}),
        reasonCodes,
        sourceNodeIds: nodeIds,
        sourceEventSequence: view.lastEventSequence,
        evidenceRefs: nodeIds.map((nodeId) => evidenceRef(view, nodeId)),
      });
    }

    for (const node of [...view.evidence.nodes].sort((left, right) => left.nodeId.localeCompare(right.nodeId))) {
      const parsed = node.parsedOutput;
      if (!parsed?.available) continue;
      const failedTests = parsed.structured.testResults?.failed ?? 0;
      if (failedTests <= 0) continue;
      advice.push({
        suggestion: `Node ${node.nodeId} reports ${failedTests} parsed test failure(s); treat this as derived evidence and keep process/artifact truth authoritative.`,
        category: 'evidence',
        actionable: false,
        reasonCodes: ['parsed_test_failures'],
        sourceNodeIds: [node.nodeId],
        sourceEventSequence: view.lastEventSequence,
        evidenceRefs: [evidenceRef(view, node.nodeId), `parsed:${parsed.parserVersion}`],
      });
    }

    if (locallyHealthy && view.state === 'planned') {
      const ready = readyNodes(view);
      if (ready.length > 0 && context.routeContextId && tools.has('execution_start')) {
        advice.push({
          suggestion: ready.length >= 2
            ? `${ready.length} independent ready nodes can be dispatched within the configured concurrency bound.`
            : 'A ready node can be started now.',
          category: 'parallelization',
          actionable: true,
          proposedNext: { tool: 'execution_start', args: { routeContextId: context.routeContextId, runId: view.runId } },
          reasonCodes: ['independent_ready_nodes'],
          sourceNodeIds: ready,
          sourceEventSequence: view.lastEventSequence,
          evidenceRefs: ready.map((nodeId) => evidenceRef(view, nodeId)),
        });
      }
    }

    if (view.state === 'running') {
      const running = view.nodes.filter((node) => node.state === 'running').map((node) => node.nodeId).sort((a, b) => a.localeCompare(b));
      if (running.length > 0 && tools.has('execution_wait')) {
        advice.push({
          suggestion: `${running.length} node(s) are running; use bounded event-driven wait only when progress depends on the next persisted event, never busy polling.`,
          category: 'timing',
          actionable: true,
          proposedNext: { tool: 'execution_wait', args: { runId: view.runId, afterSequence: view.lastEventSequence, timeoutMs: 60_000 } },
          reasonCodes: ['running_nodes_event_wait'],
          sourceNodeIds: running,
          sourceEventSequence: view.lastEventSequence,
          evidenceRefs: running.map((nodeId) => evidenceRef(view, nodeId)),
        });
      }
    }

    const seenHashes = new Set<string>();
    if (context.includeCacheValidation !== false) for (const node of [...view.evidence.nodes].sort((left, right) => left.nodeId.localeCompare(right.nodeId))) {
      for (const artifact of [...node.artifacts].sort((left, right) => left.path.localeCompare(right.path))) {
        if (!artifact.sha256 || seenHashes.has(artifact.sha256)) continue;
        seenHashes.add(artifact.sha256);
        const reuse = await this.runtime.execution.artifacts.findReusable(context.scope, { sha256: artifact.sha256, excludeRunId: view.runId });
        if (!reuse.found || !reuse.artifact) continue;
        advice.push({
          suggestion: 'A verified prior artifact with the same SHA-256 still exists. Reuse is advisory only; this does not prove current inputs or side effects are unchanged.',
          category: 'optimization',
          actionable: false,
          reasonCodes: ['verified_reuse_candidate'],
          sourceNodeIds: [node.nodeId],
          sourceEventSequence: view.lastEventSequence,
          evidenceRefs: [evidenceRef(view, node.nodeId), `artifact:${reuse.artifact.artifactId}`],
        });
      }
    }

    return advice;
  }
}
