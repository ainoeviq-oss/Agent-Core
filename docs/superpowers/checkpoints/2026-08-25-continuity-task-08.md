# Task 8 Checkpoint — Cross-Session Continuity Acceptance

Date: 2026-08-25
Worktree: `F:\Projects\Agent-Core\.worktrees\local-continuity-execution-fabric`
Branch: `feature/local-continuity-execution-fabric`
Base before task: `e4b7d024dbb214d1bab96aef1cbdaef0ac86928d`

## Acceptance fixture

Created `tests/fixtures/continuity/resume-scenarios.json` with canonical scenarios A–G and `tests/continuity-resume.acceptance.test.ts`.

## Acceptance scenarios proven

A. Two completed tasks plus one deferred task are returned by a fresh route with correct states.

B. A terminal task with three frontier candidates preserves the same deterministic priority order on a fresh route.

C. Memory/runtime restart preserves task ID, last checkpoint ID, frontier IDs/order, and continuity snapshot hash.

D. A fresh continuation route resumes the same running task, marks the abandoned prior open turn `interrupted`, opens a replacement turn, and never invents task completion.

E. Same principal, different project scopes do not cross-contaminate.

F. Same project, different principals do not cross-contaminate.

G. 75 unrelated old semantic DMF observation memories do not alter the current continuity state or continuity snapshot hash.

## Defect found and fixed through acceptance

Initial RED result: 7/8 scenarios PASS; Scenario D failed because `ContinuityStore.beginTurn(resumeTaskId)` created a replacement turn but left the prior abandoned turn `open`.

Root cause: resume logic updated/resumed task state but performed no old-open-turn reconciliation.

Fix: before creating a replacement turn for an existing task, the store deterministically queries scoped open turns for that task and, inside the same transaction that opens the replacement turn:
- changes each prior open turn to `interrupted`;
- stamps `closed_at`;
- appends `continuity.turn_interrupted` provenance with prior turn ID, task ID, replacement turn ID, route ID, and reason `resumed_by_new_turn`.

The task itself remains/re-enters `running`; it is never marked completed by resume.

## TDD / verification evidence

RED acceptance:
- 8 scenarios total;
- 7 PASS;
- 1 FAIL exactly on prior open turn state (`open` vs expected `interrupted`).

GREEN focused:
- acceptance: 8/8 PASS;
- continuity store regression: 6/6 PASS;
- continuity routing regression: 4/4 PASS;
- combined focused: 18/18 PASS;
- `npm run build`: PASS.

Full regression:
- 55/55 test files PASS;
- 206/206 tests PASS;
- exit code 0.

## Live safety

No live production migration/restart/deployment was performed. All acceptance DBs and temp files are F:-backed isolated test state.

## Status

Task 8 complete. Workstream A — Local Agent Continuity is acceptance-green. Next: Task 9 — persistent Execution Fabric config, SQLite schema, worker, and principal/project-scoped store.
