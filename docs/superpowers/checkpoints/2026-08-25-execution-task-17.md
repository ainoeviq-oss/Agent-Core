# Task 17 Checkpoint — Cross-Session Execution Recovery

Date: 2026-08-25
Branch: `feature/local-continuity-execution-fabric-admin`

## Implemented

- Added `src/execution/recovery.ts`.
- Execution startup reconciles persisted `running` attempts before becoming ready.
- A durable terminal `attempt-XXX.result.json` with matching run/node/attempt identity wins on restart.
- Missing/mismatched terminal marker marks the persisted attempt + node `interrupted`; PID absence is never success evidence.
- Recovered/interrupted facts are appended to the execution event journal.
- Interrupted nodes remain explicitly retryable and retry creates the next attempt while prior evidence remains immutable.
- ExecutionService now returns bounded principal/project-scoped continuity summaries for active/interrupted runs and the latest execution checkpoint.
- `ContinuitySnapshot` can deterministically attach execution resume state and re-hash within the existing 20k character budget.
- `capability_route` and `continuity_status` augment DMF continuity with execution resume state only when execution is enabled/healthy; execution degradation does not erase DMF continuity.

## Cross-session acceptance

- Fresh same-principal route sees the old active run ID and original continuity task ID.
- Fresh route can call read-side `execution_status` on the old run without the original route context.
- Another principal cannot see the run in continuity snapshot and cannot inspect it.

## TDD evidence

Initial RED: `src/execution/recovery.ts` missing.

Focused GREEN:
- recovery: 4/4 PASS
- execution store/scheduler/wake/bridge regression: 18/18 PASS
- routing + cross-session acceptance + checkpoint regression: 15/15 PASS
- build: PASS

Full regression, F:-backed TEMP/TMP with managed async worker + OS wake:
- 65/65 test files PASS
- 252/252 tests PASS
- exit code 0
- duration 135.06s

## Invariants proven

- process/PID disappearance != success
- durable terminal marker beats stale DB `running` state
- missing marker => interrupted
- explicit retry preserves attempt 1 and creates attempt 2
- active/interrupted runs are bounded and deterministic in continuity rehydration
- ownership remains principal/project scoped

## Next

Task 18: unified Memory / Continuity / Execution health, graceful shutdown of both SQLite workers and running nodes, and separate tray visibility for Memory vs Execution.