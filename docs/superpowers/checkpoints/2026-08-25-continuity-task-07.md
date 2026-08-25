# Task 7 Checkpoint — Structured Checkpoint / Finalization + Frontier Promotion

Date: 2026-08-25
Worktree: `F:\Projects\Agent-Core\.worktrees\local-continuity-execution-fabric`
Branch: `feature/local-continuity-execution-fabric`
Base before task: `251308605cc2345fb5482ce63ecda9726804e061`

## Scope completed

Added the first-class continuity finalization/read surface:
- `task_checkpoint`
- `continuity_status`
- `continuity_get_task`
- `continuity_frontier`

The feature-worktree MCP surface is now 35 tools. The capability stage intentionally remains `v4-automatic-capability-routing`; the master plan defers the v5 stage label until the execution fabric is production-ready in Task 21.

## Checkpoint semantics

`task_checkpoint` is bound to the continuity identity already stored on the authenticated route context.

Validation order:
1. route exists and has not expired;
2. authenticated principal owns the route;
3. route contains persisted continuity task/turn IDs;
4. checkpoint payload passes deterministic bounded normalization;
5. continuity checkpoint/task/frontier mutation commits;
6. high-value semantic promotion runs;
7. terminal/interrupted turn closure occurs only after prior persistence succeeds;
8. fresh bounded snapshot is returned.

Terminal `completed|failed|cancelled` checkpoints require 2–5 next candidates unless `projectTerminal=true`. Invalid terminal finalization leaves task running, turn open, and creates no checkpoint/frontier rows.

Non-terminal `running|blocked|deferred` checkpoints leave the turn open. An `interrupted` checkpoint marks the turn interrupted/resumable.

Cross-principal finalization is rejected with `ROUTE_PRINCIPAL_MISMATCH`.

## DMF promotion policy implemented

Created `src/continuity/promoter.ts`.

Promoted semantic evidence:
- explicit decisions -> `decision` memory;
- verified artifact descriptors/hash -> `artifact` memory;
- failed terminal checkpoint -> `failure` memory.

Canonical keys are deterministic from task identity + bounded SHA-256 digest of the semantic key/path. Structured-state revision authority is used for deterministic updates.

Raw stdout/stderr is not bulk-promoted. Failure memory contains structured summary, blockers, and bounded evidence references/results only.

## MCP/tool surface

Created `src/mcp/continuity-tools.ts` and registered it from `src/mcp/server.ts`.
`agent_core_capabilities.enabled` now advertises `continuity.local_ledger` plus the four tool names while preserving the existing stage label.

Existing MCP tool-count contract tests were updated from 31 to 35 while preserving the exact eight memory tools and six capability tools.

## TDD evidence

RED 1:
- 5/5 new checkpoint tests failed because the four tools did not exist.
- Initial helper could not parse MCP unknown-tool text; test helper only was corrected.

RED 2:
- 5/5 still failed cleanly for missing continuity tools / missing expected behavior.

GREEN focused:
- `tests/continuity-checkpoint.test.ts`: 5/5 PASS.
- combined MCP regression batch: 4/4 files, 13/13 tests PASS.
- `npm run build`: PASS.

## Full regression and flake investigation

First full run:
- 53/54 files PASS;
- 197/198 tests PASS;
- sole failure: pre-existing `tests/tray-manager.test.ts` identity probe exceeded its 5s default timeout.
- Task 7 source does not touch tray/runtime launcher code.

Systematic reproduction:
- isolated failing tray case rerun 3 consecutive times;
- 3/3 PASS at ~2.42–2.44s test runtime;
- no production/test timeout changes made.

Final full rerun:
- 54/54 test files PASS;
- 198/198 tests PASS;
- exit code 0.

## Live safety

No live production DMF migration or feature deployment occurred. Schema v2 and 35-tool behavior remain isolated to the feature worktree until staged rollout.

## Status

Task 7 complete. Next: Task 8 — cross-session continuity acceptance covering completed/deferred/frontier persistence, restart rehydration, interrupted/open work, principal/project isolation, and chatter resistance.
