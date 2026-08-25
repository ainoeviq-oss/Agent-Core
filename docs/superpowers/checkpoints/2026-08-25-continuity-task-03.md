# Local Continuity Execution Fabric — Task 3 Checkpoint

Date: 2026-08-25 (Asia/Jakarta)
Branch: `feature/local-continuity-execution-fabric`
Task: DMF Schema v2 — Continuity Ledger
Baseline parent: `0cd377b`

## Result

**PASS.** The feature worktree now has a forward-only deterministic DMF schema migration from v1 to v2 that adds the Continuity Ledger without applying any migration to the live/main Agent Core database.

## TDD evidence

1. `tests/continuity-schema.test.ts` and the v1→v2 recovery expectation were written before production schema changes.
2. Initial RED proved the missing feature: `MEMORY_SCHEMA_VERSION` was still 1 and a sabotaged v1 database did not attempt a v2 migration.
3. A teardown-only EBUSY noise was removed with `try/finally`; RED was rerun so the remaining failures were feature-only.
4. Clean RED: 2/2 continuity schema tests failed for schema version/migration absence; memory recovery also failed because schema remained v1.
5. Minimum migration implementation was added.
6. Focused GREEN batch:
   - build: PASS
   - `continuity-schema.test.ts`: 2/2 PASS
   - `memory-recovery.test.ts`: 5/5 PASS
   - `memory-schema.test.ts`: 2/2 PASS
7. Full regression: **50/50 test files, 180/180 tests PASS**, exit 0.

## Schema v2

Migration identity:

- v1: `001_initial_memory`
- v2: `002_continuity_ledger`
- current schema version: `2`

New tables:

- `continuity_turns`
- `continuity_tasks`
- `continuity_task_dependencies`
- `continuity_checkpoints`
- `continuity_frontier`

The tables carry principal/project scope, route/task identity, observable input/checkpoint state, task dependencies, task status, frontier status, stable evidence JSON fields, timestamps, and indexes for deterministic scoped ordering.

## Migration semantics

`MEMORY_MIGRATIONS` is an ordered migration registry. Both the synchronous schema initializer used by tests and the production `MemoryStore.open()` path now apply only migrations above `PRAGMA user_version`.

Production `MemoryStore.open()` preserves the existing safety contract:

1. open SQLite worker;
2. read current `user_version`;
3. reject a schema newer than the runtime;
4. if an existing DB needs a forward migration, create a consistent SQLite backup first;
5. execute all missing migration SQL, migration-ledger rows, and final `PRAGMA user_version=2` in one worker transaction;
6. COMMIT only if every operation succeeds; otherwise ROLLBACK;
7. run integrity check before reporting healthy.

## Rollback proof

The continuity migration test intentionally constructs a v1-equivalent database, preserves a real v1 memory item, and sabotages `continuity_tasks` with an incompatible shape so a later v2 index statement fails.

Observed after the rejected open:

- `user_version` remains 1;
- migration version 2 is absent from `memory_schema_migrations`;
- a table created earlier in the failed v2 transaction is absent, proving SQL rollback;
- the pre-existing v1 memory row is still present;
- `PRAGMA integrity_check` remains `ok`;
- a timestamped `pre-migration-v1-to-v2` backup exists.

## Successful v1→v2 recovery proof

A separate recovery test:

- creates a real memory item;
- downgrades a stopped test DB to a v1-equivalent state;
- reopens through `MemoryService`;
- verifies schemaVersion=2, integrity=`ok`, all five continuity tables, and a `pre-migration-v1-to-v2` backup;
- verifies the original memory ID/value remains readable after migration.

The existing v0 migration test now expects one forward backup named `pre-migration-v0-to-v2` and confirms original memory remains intact.

## Verification

- `npm run build`: PASS
- focused continuity schema: 2/2 PASS
- focused memory recovery: 5/5 PASS
- focused base memory schema: 2/2 PASS
- full suite: **50/50 files, 180/180 tests PASS**
- `git diff --check`: PASS

Independent build/schema/recovery commands were launched concurrently with Agent Core `start_process`; a `Wait-Process` wake worker signaled the terminal batch without shell busy polling.

## Safety / live-state note

This task modified only the isolated feature worktree and F:-backed test databases. The live/main `runtime\memory\agent-core-memory.sqlite` was **not** migrated to v2. Live migration remains a staged-rollout responsibility after continuity/execution acceptance gates pass.

## Next

Task 4: implement the transactional Continuity Store on the existing DMF worker, with principal/project isolation, task-state transition validation, deterministic checkpoint hashes, frontier ordering, and append-only provenance events.
