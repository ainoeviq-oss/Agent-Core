# Task 12 Checkpoint — Concurrent Dependency-Aware Scheduler

Date: 2026-08-25
Branch: `feature/local-continuity-execution-fabric`

## Implemented

Created:

- `src/execution/scheduler.ts`
- `src/execution/service.ts`
- `tests/execution-scheduler.test.ts`

Extended:

- `src/execution/store.ts`
- `src/runtime/services.ts`

## Persistent scheduler state

ExecutionStore now persists:

- validated DAG nodes and hard dependencies
- node state and attempt count
- attempt rows before process launch
- process PID after launch
- terminal attempt facts from durable result markers
- node failure/block state
- run state transitions
- explicit retry reset while preserving prior attempts

All run/node/attempt access remains principal/project scoped.

## Scheduler semantics

The scheduler serializes mutation/dispatch decisions per run while allowing independent node processes to run concurrently.

Rules proven:

- independent A and B dispatch together
- when A succeeds while B is still running, C(depends only A) dispatches immediately
- D(depends A+B) remains queued until both A and B succeed
- A failure leaves unrelated B running
- hard dependents of failed/blocked/interrupted/cancelled dependencies become blocked
- no automatic retry
- explicit retry resets the target + blocked dependents for deterministic re-evaluation
- maxConcurrency is enforced on every dispatch
- terminal run state is derived from factual node states

No scheduler polling loop is used. New dispatch is triggered by process completion promises and explicit start/retry calls.

## Real retry evidence

A real PowerShell node was used for retry acceptance:

- attempt 1 intentionally exits 9 and writes failure evidence
- explicit retry creates attempt 2
- attempt 2 succeeds
- `attempt-001.result.json` remains unchanged
- `attempt-002.result.json` is independently present and successful
- node attemptCount becomes 2

## Runtime facade

RuntimeServices now exposes an `ExecutionService` instance. The execution service is not automatically opened and the default execution config remains disabled, so this does not enable live rollout.

## TDD evidence

RED:

- scheduler/service modules initially missing
- after surface stubs, 5/5 behavior tests failed at `EXECUTION_SERVICE_NOT_IMPLEMENTED`

GREEN focused:

- `npm run build` PASS
- `tests/execution-scheduler.test.ts` 5/5 PASS

Full regression:

- 60/60 test files PASS
- 228/228 tests PASS
- exit code 0
- `git diff --check` PASS before regression

## Next

Task 13: persist monotonic execution events and provide an in-process event-driven wake coordinator. Persist-before-signal is mandatory; waiting must never use a DB polling loop.
