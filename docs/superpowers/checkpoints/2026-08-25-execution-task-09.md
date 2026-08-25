# Task 9 Checkpoint — Persistent Execution Fabric Store

Date: 2026-08-25
Branch: `feature/local-continuity-execution-fabric`
Worktree: `F:\Projects\Agent-Core\.worktrees\local-continuity-execution-fabric`

## Scope

Implemented the first durable layer of the deterministic multi-command Execution Fabric without enabling it in the live runtime or migrating any production database.

## Development flag / paths

Execution remains disabled by default during development. Configuration now supports:

- `AGENT_CORE_EXECUTION_ENABLED` (default `false` until staged rollout)
- `AGENT_CORE_EXECUTION_DB_PATH` → default `runtime\execution\agent-core-execution.sqlite`
- `AGENT_CORE_EXECUTION_LOG_ROOT` → default `runtime\execution\runs`
- `AGENT_CORE_EXECUTION_MAX_CONCURRENCY` → 4
- `AGENT_CORE_EXECUTION_MAX_NODES` → 128
- `AGENT_CORE_EXECUTION_WAIT_MAX_MS` → 60000
- `AGENT_CORE_EXECUTION_BUSY_TIMEOUT_MS` → 5000

## Persistent execution schema v1

Created:

- `execution_schema_migrations`
- `execution_runs`
- `execution_nodes`
- `execution_dependencies`
- `execution_attempts`
- `execution_events`
- `execution_memory_sync_queue`

Foreign keys, bounded states/checks, scope indexes, dependency indexes, event indexes, and sync queue indexes are present.

## SQLite ownership

Execution SQLite is owned by one Node worker thread using `node:sqlite DatabaseSync`.

The parent process communicates through a bounded message protocol only. No execution HTTP/TCP/network listener was added.

Worker properties:

- foreign keys ON
- WAL journal mode
- synchronous NORMAL
- configurable busy timeout
- defensive mode when supported
- quick_check on open
- integrity_check
- BEGIN IMMEDIATE transactions with rollback
- WAL TRUNCATE checkpoint on close
- bounded worker response size

## ExecutionStore

Implemented:

- open / close
- health/integrity status
- create durable planned run
- get scope-owned run
- list scope-owned runs
- principal/project isolation
- normalized objective
- bounded stable metadata JSON
- concurrency validation
- deterministic ordering

## TDD evidence

RED observed before implementation:

- execution config tests failed because `config.execution` was absent
- schema behavior failed because `ExecutionStore.open()` was a stub
- store behavior failed because worker/store persistence methods were stubs

GREEN focused verification:

- `npm run build` → PASS
- `tests/execution-schema.test.ts` → 2/2 PASS
- `tests/execution-store.test.ts` → 4/4 PASS

The schema tests prove reopen and crash/WAL recovery: a committed run survives while an uncommitted externally-held transaction killed before commit is never invented as durable state.

## Full regression

First full run produced one unrelated existing tray timing failure:

- 56 files / 211 tests passed
- only `accepts identity only when port owner, executable, and command signature all match` exceeded its existing 5000 ms timeout

Systematic reproduction:

- focused tray test passed unchanged in 2.52 s
- process inspection found no leaked execution/node worker from Task 9
- no test timeout or assertion was weakened

Clean full rerun:

- 57/57 test files PASS
- 212/212 tests PASS
- exit code 0
- tray identity test passed unchanged in 4.93 s

## Safety

- live Agent Core execution feature was not enabled
- live DMF database was not migrated or modified by Task 9 rollout work
- no credential values were printed or stored in execution fixtures
- no global Git configuration was changed
- `git diff --check` passed before final regression

## Next

Task 10: deterministic DAG validation and ready-node resolution, including command safety, workspace containment, inline-secret rejection, cycle/missing-dependency rejection, and stable topological ordering.
