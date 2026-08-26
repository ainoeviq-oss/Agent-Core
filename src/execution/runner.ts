import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, type Hash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolveShellInvocation } from '../runtime/platform-shell.js';
import type { WorkspacePolicy } from '../runtime/workspace.js';
import type { ValidatedExecutionNode } from './dag.js';
import { verifyExecutionArtifacts, type ExecutionEvidenceManifest } from './evidence.js';
import type { ExecutionLogStore, ExecutionResultMarker, ExecutionResultState } from './log-store.js';

export interface ExecutionRunHandle {
  pid: number | null;
  completion: Promise<ExecutionResultMarker>;
  terminate(state?: 'interrupted' | 'cancelled'): void;
}

interface StreamEvidence {
  bytes: number;
  hash: Hash;
}

function createEvidenceTransform(evidence: StreamEvidence): Transform {
  return new Transform({
    transform(chunk: Buffer | string, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      evidence.bytes += buffer.length;
      evidence.hash.update(buffer);
      callback(null, buffer);
    },
  });
}

async function verifyDeclaredEvidence(
  workspace: WorkspacePolicy,
  node: ValidatedExecutionNode,
): Promise<ExecutionEvidenceManifest> {
  try {
    return await verifyExecutionArtifacts(workspace, node.expectedArtifacts);
  } catch {
    return {
      verification: 'failed',
      artifacts: [],
      error: 'Declared execution artifact verification failed safely',
    };
  }
}

function spawnCommand(command: string, cwd: string): ChildProcessWithoutNullStreams {
  const invocation = resolveShellInvocation(command);
  return spawn(invocation.executable, invocation.args, {
    cwd,
    windowsHide: invocation.windowsHide,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function terminalState(
  requested: 'interrupted' | 'cancelled' | undefined,
  timedOut: boolean,
  exitCode: number | null,
  error: Error | undefined,
): ExecutionResultState {
  if (requested) return requested;
  if (timedOut || error || exitCode !== 0) return 'failed';
  return 'succeeded';
}

export class ExecutionCommandRunner {
  constructor(
    readonly logs: ExecutionLogStore,
    readonly workspace: WorkspacePolicy,
  ) {}

  async start(
    runId: string,
    node: ValidatedExecutionNode,
    attemptId: string,
    attemptNo: number,
  ): Promise<ExecutionRunHandle> {
    const paths = await this.logs.prepareAttempt(runId, node.id, attemptNo);
    const startedAt = Date.now();
    const stdoutEvidence: StreamEvidence = { bytes: 0, hash: createHash('sha256') };
    const stderrEvidence: StreamEvidence = { bytes: 0, hash: createHash('sha256') };
    const child = spawnCommand(node.command, node.cwd);
    child.stdin.end();

    const stdoutPipeline = pipeline(
      child.stdout,
      createEvidenceTransform(stdoutEvidence),
      createWriteStream(paths.stdoutPath, { flags: 'a' }),
    );
    const stderrPipeline = pipeline(
      child.stderr,
      createEvidenceTransform(stderrEvidence),
      createWriteStream(paths.stderrPath, { flags: 'a' }),
    );

    let requestedState: 'interrupted' | 'cancelled' | undefined;
    let timedOut = false;
    let completed = false;
    let processError: Error | undefined;
    child.once('error', (error) => { processError = error; });

    const closePromise = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
    });

    const timer = setTimeout(() => {
      if (completed) return;
      timedOut = true;
      child.kill();
    }, node.timeoutMs);

    const completion = (async (): Promise<ExecutionResultMarker> => {
      const terminal = await closePromise;
      clearTimeout(timer);
      const pipelineResults = await Promise.allSettled([stdoutPipeline, stderrPipeline]);
      completed = true;
      const pipelineFailure = pipelineResults.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (!processError && pipelineFailure) {
        processError = pipelineFailure.reason instanceof Error
          ? pipelineFailure.reason
          : new Error(String(pipelineFailure.reason));
      }
      const finishedAt = Date.now();
      const processState = terminalState(requestedState, timedOut, terminal.exitCode, processError);
      const common = {
        runId,
        nodeId: node.id,
        attemptId,
        attemptNo,
        startedAt,
        finishedAt,
        exitCode: terminal.exitCode,
        signal: terminal.signal ?? null,
        stdoutBytes: stdoutEvidence.bytes,
        stderrBytes: stderrEvidence.bytes,
        stdoutSha256: stdoutEvidence.hash.digest('hex'),
        stderrSha256: stderrEvidence.hash.digest('hex'),
      };
      const processErrorText = timedOut
        ? `Execution timed out after ${node.timeoutMs} ms`
        : processError?.message;
      let marker: ExecutionResultMarker;
      if (node.expectedArtifacts.length > 0) {
        const evidence = await verifyDeclaredEvidence(this.workspace, node);
        const evidenceState = evidence.verification === 'verified' ? 'verified' : 'failed';
        const state: ExecutionResultState = processState === 'succeeded' && evidenceState === 'failed'
          ? 'failed'
          : processState;
        marker = {
          version: 2,
          ...common,
          state,
          processState,
          evidenceState,
          evidence,
          ...(processErrorText ? { error: processErrorText } : {}),
          ...(!processErrorText && processState === 'succeeded' && evidenceState === 'failed'
            ? { error: 'Required execution artifact evidence verification failed' }
            : {}),
        };
      } else {
        marker = {
          version: 1,
          ...common,
          state: processState,
          ...(processErrorText ? { error: processErrorText } : {}),
        };
      }
      await this.logs.writeResultAtomic(marker);
      return marker;
    })();

    return {
      pid: child.pid ?? null,
      completion,
      terminate: (state = 'cancelled') => {
        if (completed || requestedState) return;
        requestedState = state;
        child.kill();
      },
    };
  }

  async run(
    runId: string,
    node: ValidatedExecutionNode,
    attemptId: string,
    attemptNo: number,
  ): Promise<ExecutionResultMarker> {
    const handle = await this.start(runId, node, attemptId, attemptNo);
    return handle.completion;
  }
}
