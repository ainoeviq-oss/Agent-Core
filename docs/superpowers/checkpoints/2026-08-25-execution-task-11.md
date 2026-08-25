# Task 11 Checkpoint — Durable Execution Logs and Command Runner

Date: 2026-08-25
Branch: `feature/local-continuity-execution-fabric`

## Implemented

Created:

- `src/execution/log-store.ts`
- `src/execution/runner.ts`
- `tests/execution-runner.test.ts`

Per-attempt evidence layout:

- `runtime\execution\runs\<runId>\<nodeId>\attempt-001.stdout.log`
- `runtime\execution\runs\<runId>\<nodeId>\attempt-001.stderr.log`
- `runtime\execution\runs\<runId>\<nodeId>\attempt-001.result.json`

The log store refuses to overwrite an existing attempt evidence set.

## Factual terminal marker

The result marker is written only after:

1. the PowerShell child reaches a terminal process state,
2. stdout/stderr pipelines are finished,
3. byte counts and SHA-256 hashes are final.

Marker includes:

- run/node/attempt identity
- attempt number
- state
- start/finish timestamps
- exact exit code and signal
- stdout/stderr byte counts
- stdout/stderr SHA-256 hashes
- factual timeout/spawn/pipeline error when applicable

Marker write uses same-directory temporary file + fsync + rename. A missing marker returns `null`; it is never interpreted as success.

## Bounded logs

`ExecutionLogStore.readLog()` uses byte offsets and a hard maximum read size. It returns offset, next offset, total bytes, EOF flag, and decoded data.

## Runner lifecycle

`ExecutionCommandRunner`:

- launches PowerShell with NoLogo/NoProfile/NonInteractive
- streams stdout/stderr durably
- records non-zero exit codes as failed
- supports explicit `interrupted` / `cancelled` termination
- has bounded per-node timeout
- never reuses an existing attempt evidence set

## TDD evidence

RED:

- log-store/runner modules initially absent
- after surface stubs, 5/5 behavior tests failed with `EXECUTION_RUNNER_NOT_IMPLEMENTED`

GREEN focused:

- `npm run build` PASS
- `tests/execution-runner.test.ts` 5/5 PASS

Behavior proven:

- exit code 7 retained exactly
- stdout/stderr retained separately
- byte-offset pagination exact
- SHA-256/byte counts reproduce durable files
- result marker atomically visible only at terminal state
- interrupted run is not success
- existing attempt evidence cannot be overwritten

## Full regression and test-harness finding

The growing parallel suite exposed an existing tray PowerShell/WMI identity test whose default 5s test timeout was not a correctness requirement and repeatedly crossed 5s under load. Its assertions were unchanged; only that integration test now has an explicit 20s timeout, committed separately as `test: stabilize tray identity timing under suite load`.

Final default full regression after that harness fix:

- 59/59 test files PASS
- 223/223 tests PASS
- exit code 0
- tray identity assertions PASS
- `git diff --check` PASS before regression

## Next

Task 12: persistent concurrent scheduler/service with dependency unlocking, max-concurrency enforcement, independent-failure behavior, and explicit retry preserving earlier attempt evidence.
