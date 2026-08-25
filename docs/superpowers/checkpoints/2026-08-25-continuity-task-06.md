# Task 6 Checkpoint — Continuity-Aware `capability_route`

Date: 2026-08-25
Worktree: `F:\Projects\Agent-Core\.worktrees\local-continuity-execution-fabric`
Branch: `feature/local-continuity-execution-fabric`
Base before task: `eec37f7424cb23e79ca878755b91e4a3bde88eae`

## Scope completed

Attached the Continuity Ledger to `capability_route` without replacing existing DMF preflight or capability routing.

### New optional route input

`continuity` supports:
- objective
- acceptanceCriteria
- constraints
- parentTaskId
- resumeTaskId

### New route context identity

A successfully persisted continuity turn binds these factual fields to the in-memory route context:
- `continuityTurnId`
- `continuityTaskId`
- `continuitySnapshotHash`

### New route response state

`capability_route` now returns:
- `continuityStatus`: disabled / healthy / degraded / ambiguous
- `continuityTurnId`
- `continuityTaskId`
- `continuitySnapshot`
- `continuitySnapshotHash`
- `continuityResumeCandidates`

DMF `memoryStatus` remains independent from continuity status.

## Deterministic continuation behavior

A bounded exact phrase set recognizes continuation prompts such as `lanjutkan`, `continue`, and `resume`.

- Exactly one running/interrupted task: auto-resume that task.
- More than one running/interrupted task: report deterministic candidates, mark continuity `ambiguous`, and create no new task/turn.
- Explicit `resumeTaskId` remains authoritative.

This prevents a vague `lanjutkan` request from becoming a new meaningless task when multiple prior tasks are available.

## Degrade-safe contract

Normal DMF preflight and continuity snapshot retrieval begin together using promise-level concurrency. Continuity persistence failure does not fail MCP routing. The route is still created, `continuityStatus=degraded` is returned, and no unpersisted task/turn identity is invented.

## Redaction proof

The continuity turn is persisted before execution. Tests inject bearer/token-like secret material into route task/context and verify:
- persisted `continuity_turns.input_text` is redacted;
- persisted context does not contain the secret;
- continuity provenance events contain no secret plaintext.

## TDD evidence

RED:
- 4/4 new continuity-routing tests failed because current route response contained no continuity state.

GREEN focused:
- `tests/continuity-routing.test.ts`: 4/4 PASS.
- `tests/memory-routing.test.ts`: 5/5 PASS.
- `tests/route-context-store.test.ts`: 7/7 PASS.
- focused total: 16/16 PASS.
- `npm run build`: PASS.

Full regression:
- 53/53 test files PASS.
- 193/193 tests PASS.
- exit code 0.

## Status

Task 6 complete. Next: Task 7 — first-class `task_checkpoint`, continuity status/task/frontier tools, transactional finalization, frontier promotion, and DMF structured promotion.
