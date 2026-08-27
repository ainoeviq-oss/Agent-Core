import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseExecutionOutput, EXECUTION_OUTPUT_PARSER_VERSION } from '../src/execution/output-parser.js';

function sha(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function parse(stdout: string, stderr = '', exitCode = 0) {
  return parseExecutionOutput({
    nodeId: 'A', attemptNo: 1, stdout, stderr, exitCode,
    stdoutSha256: sha(stdout), stderrSha256: sha(stderr),
  });
}

describe('deterministic execution output parser', () => {
  it('extracts a Vitest test summary deterministically with source hashes', () => {
    const stdout = `Test Files  3 passed (3)\nTests  19 passed | 1 skipped (20)\n`;
    const first = parse(stdout);
    const second = parse(stdout);
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      version: 1,
      parserVersion: EXECUTION_OUTPUT_PARSER_VERSION,
      nodeId: 'A', attemptNo: 1,
      source: { stdoutSha256: sha(stdout), stderrSha256: sha('') },
      raw: { stdoutBytes: Buffer.byteLength(stdout), stderrBytes: 0 },
      structured: { testResults: { passed: 19, failed: 0, skipped: 1 } },
    });
    expect(first.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('recognizes explicit build, warning/error, performance, and deployment patterns without overriding exit truth', () => {
    const stdout = [
      '> agent-core@0.5.3 build',
      '> tsc -p tsconfig.json',
      'PERF wake_ms=7.5',
      'Deployment status: deployed',
      'warning: deprecated fixture',
    ].join('\n');
    const stderr = 'error TS2322: Type mismatch\nwarning: second warning\n';
    const result = parse(stdout, stderr, 2);
    expect(result.structured).toMatchObject({
      buildStatus: 'failure',
      deploymentStatus: 'deployed',
      performanceMetrics: { wake_ms: 7.5 },
      warningCount: 2,
      errorPatterns: [expect.objectContaining({ type: 'typescript', count: 1 })],
    });
    expect(result.exitCode).toBe(2);
  });

  it('redacts and bounds error samples instead of copying raw secrets', () => {
    const secret = 'SENTINEL_SECRET_1234567890';
    const stderr = `error: token=${secret} connection refused at https://example.invalid\n`;
    const result = parse('', stderr, 1);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secret);
    expect(result.structured.errorPatterns?.[0]?.sample).toContain('[REDACTED:TOKEN]');
    expect(result.structured.errorPatterns?.[0]?.sample.length).toBeLessThanOrEqual(240);
  });

  it('does not guess structured facts from unknown prose', () => {
    const result = parse('everything seems kind of okay maybe perhaps\n');
    expect(result.structured).toEqual({});
    expect(result.confidence).toBe(0);
  });

  it('never reports build success when the factual process exit code is non-zero', () => {
    const result = parse('> package build\n> tsc -p tsconfig.json\nBuild completed successfully\n', '', 9);
    expect(result.structured.buildStatus).toBe('failure');
    expect(result.exitCode).toBe(9);
  });
});
