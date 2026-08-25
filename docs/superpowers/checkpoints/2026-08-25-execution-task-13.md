# Task 13 Checkpoint — Persisted Event Journal and Native Wake

Date: 2026-08-25
Branch: `feature/local-continuity-execution-fabric`

## Implemented

Created:

- `src/execution/wake.ts`
- `tests/execution-wake.test.ts`

Extended:

- `src/execution/store.ts`
- `src/execution/scheduler.ts`
- `src/execution/service.ts`

## Event journal

Execution now persists a monotonic event sequence per run using the existing `execution_events` table and `execution_runs.last_event_sequence`.

Event vocabulary:

- run.created
- run.started
- node.queued
- node.ready
- node.started
- node.output_available
- node.succeeded
- node.failed
- node.blocked
- node.interrupted
- node.retry_started
- node.cancelled
- run.completed
- run.failed
- run.blocked
- run.interrupted
- run.cancelled

The per-run sequence is allocated and the event row is written in one SQLite worker transaction.

## Persist-before-signal invariant

`ExecutionEventJournal.record()` awaits durable SQLite persistence before calling `ExecutionWakeCoordinator.publish()`.

Therefore a wake signal can never truthfully precede its persisted evidence row.

## Event-driven wait

`ExecutionWakeCoordinator.waitForEvent()` performs:

1. one bounded persisted-event query,
2. installs the in-process listener,
3. one bounded post-subscription query to close the query→subscribe race,
4. then waits only on in-process signal or timeout.

There is no DB busy-polling loop.

If a matching persisted event already exists, wait returns immediately.
If no event arrives before timeout, wait returns `null`; `ExecutionService.wait()` then returns current graph state without fabricating an event or advancing sequence.

## Dependency wake evidence

Acceptance proves:

- A and B can be running simultaneously,
- a waiter filtered to `node.succeeded` for A wakes when A terminal evidence is persisted,
- B is still factual `running` in the returned graph state,
- C(depends only A) proceeds without waiting for B,
- D-style dependency behavior remains protected by scheduler tests.

## Output notification coalescing

Rapid `node.output_available` records for the same run/node are coalesced within a bounded window so output bursts do not create an event storm. The coalescing slot is reserved before the async DB write, so concurrent chunks cannot fan out before persistence completes.

## TDD evidence

RED:

- wake module initially absent
- after surface stub, all five behavior tests failed because `events`, `wait`, and `recordOutputAvailable` were not implemented

GREEN focused:

- `npm run build` PASS
- `tests/execution-wake.test.ts` + `tests/execution-scheduler.test.ts` → 10/10 PASS

Full regression:

- 61/61 test files PASS
- 233/233 tests PASS
- exit code 0
- `git diff --check` PASS before regression

## Next

Task 14: expose the approved bounded Execution Fabric MCP surface over the authenticated Agent Core service while preserving principal/project isolation, deterministic DAG validation, bounded waits/log reads, and route-aware mutation safety.
