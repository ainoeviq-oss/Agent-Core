import { describe, expect, it } from 'vitest';
import {
  CONTINUITY_LIMITS,
  CONTINUITY_TASK_STATUSES,
  CONTINUITY_TURN_STATES,
  ContinuityContractError,
  FRONTIER_STATUSES,
  isTerminalContinuityTaskStatus,
  normalizeContinuityCapture,
  normalizeContinuityCheckpointInput,
} from '../src/continuity/types.js';

function expectContractCode(operation: () => unknown, code: string) {
  try {
    operation();
    throw new Error(`Expected ContinuityContractError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ContinuityContractError);
    expect((error as ContinuityContractError).code).toBe(code);
  }
}

describe('local continuity contract surface', () => {
  it('exposes the exact task, turn, and frontier state vocabulary', () => {
    expect(CONTINUITY_TURN_STATES).toEqual(['open', 'closed', 'interrupted']);
    expect(CONTINUITY_TASK_STATUSES).toEqual([
      'planned', 'ready', 'running', 'blocked', 'deferred',
      'completed', 'failed', 'cancelled', 'interrupted',
    ]);
    expect(FRONTIER_STATUSES).toEqual(['candidate', 'approved', 'deferred', 'dismissed', 'completed']);
    expect(CONTINUITY_LIMITS.nextCandidates).toBe(5);
  });

  it('treats completed, failed, and cancelled as terminal while interrupted remains resumable', () => {
    expect(isTerminalContinuityTaskStatus('completed')).toBe(true);
    expect(isTerminalContinuityTaskStatus('failed')).toBe(true);
    expect(isTerminalContinuityTaskStatus('cancelled')).toBe(true);
    expect(isTerminalContinuityTaskStatus('interrupted')).toBe(false);
    expect(isTerminalContinuityTaskStatus('blocked')).toBe(false);
    expect(isTerminalContinuityTaskStatus('deferred')).toBe(false);
  });

  it('normalizes capture text deterministically and preserves first-seen list order', () => {
    expect(normalizeContinuityCapture({
      objective: '  Ａgent Core continuity  ',
      acceptanceCriteria: ['  Same task survives  ', 'Same task survives', '', 'Evidence retained'],
      constraints: [' F: only ', 'F: only', ' no hidden reasoning '],
      parentTaskId: ' parent-1 ',
      resumeTaskId: ' resume-1 ',
    })).toEqual({
      objective: 'Agent Core continuity',
      acceptanceCriteria: ['Same task survives', 'Evidence retained'],
      constraints: ['F: only', 'no hidden reasoning'],
      parentTaskId: 'parent-1',
      resumeTaskId: 'resume-1',
    });
  });

  it('rejects oversized capture text and lists instead of silently dropping state', () => {
    expectContractCode(() => normalizeContinuityCapture({
      objective: 'x'.repeat(CONTINUITY_LIMITS.textChars + 1),
    }), 'CONTINUITY_TEXT_TOO_LONG');

    expectContractCode(() => normalizeContinuityCapture({
      acceptanceCriteria: Array.from({ length: CONTINUITY_LIMITS.acceptanceCriteria + 1 }, (_, index) => `criterion-${index}`),
    }), 'CONTINUITY_LIST_LIMIT');
  });

  it('normalizes observable checkpoint evidence without inventing omitted fields', () => {
    expect(normalizeContinuityCheckpointInput({
      routeContextId: ' route-1 ',
      status: 'running',
      summary: '  Ｖerifying Task 2  ',
      evidence: [
        { type: 'test', ref: ' tests/continuity-types.test.ts ', result: ' RED ' },
        { type: 'file', ref: ' src/continuity/types.ts ' },
      ],
      decisions: [{ key: ' mode ', value: ' deterministic ', reason: ' reproducible ' }],
      artifacts: [{ path: ' docs/checkpoint.md ', role: ' checkpoint ', hash: ' abc123 ' }],
      blockers: [{ code: ' NONE ', detail: ' no blocker ' }],
      deferred: [{ title: ' Task 3 ', reason: ' Task 2 first ' }],
      nextCandidates: [{
        title: ' Implement schema ',
        rationale: ' Task 3 ',
        dependsOnTaskIds: [' task-2 ', 'task-2', '', ' task-1 '],
        priority: 2,
      }],
    })).toEqual({
      routeContextId: 'route-1',
      status: 'running',
      summary: 'Verifying Task 2',
      evidence: [
        { type: 'test', ref: 'tests/continuity-types.test.ts', result: 'RED' },
        { type: 'file', ref: 'src/continuity/types.ts' },
      ],
      decisions: [{ key: 'mode', value: 'deterministic', reason: 'reproducible' }],
      artifacts: [{ path: 'docs/checkpoint.md', role: 'checkpoint', hash: 'abc123' }],
      blockers: [{ code: 'NONE', detail: 'no blocker' }],
      deferred: [{ title: 'Task 3', reason: 'Task 2 first' }],
      nextCandidates: [{
        title: 'Implement schema',
        rationale: 'Task 3',
        dependsOnTaskIds: ['task-2', 'task-1'],
        priority: 2,
      }],
    });
  });

  it('requires 2-5 frontier candidates for terminal tasks unless the whole project is terminal', () => {
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      expectContractCode(() => normalizeContinuityCheckpointInput({
        routeContextId: 'route-1', status, summary: `${status} summary`,
      }), 'CONTINUITY_FRONTIER_REQUIRED');

      expectContractCode(() => normalizeContinuityCheckpointInput({
        routeContextId: 'route-1', status, summary: `${status} summary`,
        nextCandidates: [{ title: 'Only one', rationale: 'Not enough' }],
      }), 'CONTINUITY_FRONTIER_REQUIRED');
    }

    expect(normalizeContinuityCheckpointInput({
      routeContextId: 'route-1',
      status: 'completed',
      summary: 'Project really finished',
      projectTerminal: true,
    })).toMatchObject({
      status: 'completed', projectTerminal: true,
    });

    expect(normalizeContinuityCheckpointInput({
      routeContextId: 'route-1',
      status: 'completed',
      summary: 'Task finished',
      nextCandidates: [
        { title: 'Next A', rationale: 'A' },
        { title: 'Next B', rationale: 'B' },
      ],
    }).nextCandidates).toHaveLength(2);
  });

  it('allows resumable non-terminal checkpoints with zero frontier candidates', () => {
    for (const status of ['running', 'blocked', 'deferred', 'interrupted'] as const) {
      expect(normalizeContinuityCheckpointInput({
        routeContextId: 'route-1', status, summary: `${status} state`,
      })).toMatchObject({ status, summary: `${status} state` });
    }
  });

  it('rejects invalid runtime statuses, empty required text, excessive candidates, and excessive dependencies', () => {
    expectContractCode(() => normalizeContinuityCheckpointInput({
      routeContextId: 'route-1', status: 'planned' as never, summary: 'invalid checkpoint state',
    }), 'CONTINUITY_STATUS_INVALID');

    expectContractCode(() => normalizeContinuityCheckpointInput({
      routeContextId: '   ', status: 'running', summary: 'valid summary',
    }), 'CONTINUITY_TEXT_REQUIRED');

    expectContractCode(() => normalizeContinuityCheckpointInput({
      routeContextId: 'route-1', status: 'running', summary: 'valid summary',
      nextCandidates: Array.from({ length: CONTINUITY_LIMITS.nextCandidates + 1 }, (_, index) => ({
        title: `candidate-${index}`, rationale: 'bounded',
      })),
    }), 'CONTINUITY_LIST_LIMIT');

    expectContractCode(() => normalizeContinuityCheckpointInput({
      routeContextId: 'route-1', status: 'running', summary: 'valid summary',
      nextCandidates: [{
        title: 'candidate', rationale: 'bounded',
        dependsOnTaskIds: Array.from({ length: CONTINUITY_LIMITS.dependencyIds + 1 }, (_, index) => `task-${index}`),
      }],
    }), 'CONTINUITY_LIST_LIMIT');
  });
});
