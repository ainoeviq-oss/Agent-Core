import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const skillPath = path.resolve(
  'plugin',
  'agent-core',
  'skills',
  'agent-core-capability-router',
  'SKILL.md',
);

function hasAll(text: string, terms: string[]) {
  for (const term of terms) expect(text).toContain(term);
}

describe('tracked Agent Core capability-router behavior contract', () => {
  it('requires route-bound project, memory, and continuity inspection before new execution work', async () => {
    const skill = await readFile(skillPath, 'utf8');
    hasAll(skill, [
      'capability_route',
      'routeContextId',
      'projectId',
      'memoryDirective',
      'memorySummary',
      'blockingGuardrails',
      'priorFailures',
      'relatedDecisions',
      'continuityDirective',
      'continuitySnapshot',
      'continuityResumeCandidates',
    ]);
    expect(skill).toMatch(/inspect[^\n.]*continuitySnapshot/i);
    expect(skill).toMatch(/resume|reuse/i);
    expect(skill).toMatch(/duplicate/i);
    expect(skill).toMatch(/hard guardrail/i);
  });

  it('requires one dependency-aware execution DAG for two or more independent commands and useful work while nodes run', async () => {
    const skill = await readFile(skillPath, 'utf8');
    hasAll(skill, [
      'execution_create',
      'execution_start',
      'dependsOn',
      'execution_wait',
      'execution_status',
      'execution_retry',
      'execution_cancel',
      'lastEventSequence',
      'afterSequence',
    ]);
    expect(skill).toMatch(/two|2|two-or-more/i);
    expect(skill).toMatch(/independent command/i);
    expect(skill).toMatch(/execution DAG|execution_create/i);
    expect(skill).toMatch(/useful independent work|independent useful work/i);
    expect(skill).toMatch(/bounded[^\n.]*execution_wait|execution_wait[^\n.]*bounded/i);
    expect(skill).toMatch(/never[^\n.]*poll/i);
  });

  it('requires verified evidence inspection, sequence re-arm, no inferred success, and factual terminal checkpointing', async () => {
    const skill = await readFile(skillPath, 'utf8');
    hasAll(skill, [
      'evidence.verification',
      'expectedArtifacts',
      'task_checkpoint',
      'execution:<runId>',
      'nextCandidates',
    ]);
    expect(skill).toMatch(/wake[^\n.]*execution_status|execution_status[^\n.]*wake/i);
    expect(skill).toMatch(/re-arm|rearm/i);
    expect(skill).toMatch(/latest[^\n.]*lastEventSequence|lastEventSequence[^\n.]*latest/i);
    expect(skill).toMatch(/never infer success|do not infer success/i);
    expect(skill).toMatch(/merged[^\n.]*evidence|evidence[^\n.]*merged/i);
    expect(skill).toMatch(/terminal[^\n.]*task_checkpoint|task_checkpoint[^\n.]*terminal/i);
    expect(skill).toMatch(/frontier|nextCandidates/i);
  });
});
