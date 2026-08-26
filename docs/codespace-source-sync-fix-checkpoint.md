# Codespace Source Synchronization Fix Checkpoint

Date: 2026-08-27
Status: Feature verification complete; pending integration/live restart proof

## Objective

Prevent Agent Core Codespace lifecycle automation from reporting `READY` while running or building a stale checkout. Startup/recovery must establish a factual chain:

`origin/main source -> local HEAD -> build -> running process -> /health version -> connection metadata -> READY`

## Observed failure

After a Codespace restart, `bash scripts/codespace/ensure-running.sh --repair --phase attach` delegated to bootstrap and printed an `agent-core@0.5.1 build` even though the current stable release/source was v0.5.2, then still reported `READY`.

## Root cause evidence

The pre-fix lifecycle had no Git source freshness gate:

- no `git fetch` before build;
- no comparison of local `HEAD` to canonical `origin/main`;
- no fast-forward-only update policy;
- no fail-closed behavior for dirty/ahead/diverged/non-main checkouts.

A second lifecycle gap allowed source/build and process to differ:

- after `npm run build`, a healthy existing tmux supervisor was not necessarily restarted;
- `/health` did not expose Agent Core version;
- health verification therefore could not reject an old process serving a new checkout.

Repository state during investigation:

- root/main before fix: `fd33f2e15c94c4a51e57b07eaed243211dbe3f8b`
- `origin/main`: `fd33f2e15c94c4a51e57b07eaed243211dbe3f8b`
- `upstream/main`: `663f78356308017c087aaa3bf912f3c1479420e4` (stale v0.5.1-era source)
- root tracked state: clean
- root untracked `.vscode/`: present and intentionally preserved
- Codespaces Git credential helper exists and a non-interactive read-only `git fetch --prune origin main` succeeded without exposing credentials.

## Isolated implementation

Worktree:

`/workspaces/Agent-Core/.worktrees/codespace-source-sync`

Branch:

`fix/codespace-source-sync`

### New source synchronization controller

`scripts/codespace/sync-source.sh`

Policy:

- default canonical remote: `origin`;
- default branch: `main`;
- bounded non-interactive fetch;
- local clean main behind origin -> `git merge --ff-only origin/main`;
- equal -> idempotent success;
- tracked-dirty -> fail closed, exit 13;
- non-main/detached -> fail closed, exit 14;
- local main ahead -> fail closed, exit 15;
- diverged -> fail closed, exit 16;
- failed fast-forward verification -> exit 17;
- untracked files are not modified or removed.

### Lifecycle ordering

Both bootstrap and attach repair now synchronize source before dependency/build readiness.

If source changes, the lifecycle `exec`s bootstrap again from the newly synchronized checkout so the running shell does not continue executing stale script contents.

A full bootstrap or any stale/missing build forces a supervisor restart before readiness can be accepted.

### Version-aware health

`/health` now reports the Agent Core server version.

Lifecycle health verification requires the runtime `/health.version` to equal the synchronized `package.json` version. A healthy but stale process therefore cannot satisfy the READY gate.

### Verified connection metadata

`connection.json` now records:

- `sourceCommit`;
- `sourceVersion`;
- `sourceRemote`;
- `sourceBranch`;
- existing verified public/OAuth/MCP metadata.

## TDD evidence

Initial RED:

- 9/9 source-sync tests failed for the intended missing behaviors.

Focused GREEN:

- shell syntax checks: PASS;
- TypeScript build: PASS;
- `tests/codespace-source-sync.test.ts`: PASS;
- `tests/codespace-contract.test.ts`: PASS;
- `tests/memory-unified-lifecycle.test.ts`: PASS;
- focused total: 3 files / 20 tests PASS / 0 failures.

The source-sync suite uses real temporary Git repositories rather than mocked Git behavior and verifies:

- clean main fast-forward;
- untracked `.vscode` preservation;
- tracked dirty protection;
- non-main protection;
- local-ahead protection;
- divergence protection;
- idempotence;
- lifecycle ordering and forced reload contract;
- runtime version mismatch rejection;
- source commit/version connection metadata.

## Full feature verification

Canonical command:

`npm run verify:release`

Result:

- brand scan: PASS;
- TypeScript build: PASS;
- test files: 82 passed, 1 skipped;
- tests: 360 passed, 32 skipped;
- failures: 0;
- release consistency: PASS, version 0.5.2;
- documentation links: PASS, 25 markdown files / 22 relative links;
- `git diff --check`: PASS.

## Safety invariants

- GitHub Actions/CI: never used.
- No force push.
- No reset of unpublished commits.
- No automatic merge of divergent history.
- No overwrite of tracked local modifications.
- No deletion of untracked editor state.
- No credential value printed.
- Windows/local Agent Core not touched.

## Repository comparison at this checkpoint

Root/main:

`/workspaces/Agent-Core` -> `fd33f2e15c94c4a51e57b07eaed243211dbe3f8b`

Feature worktree:

`/workspaces/Agent-Core/.worktrees/codespace-source-sync` -> pending feature commit

GitHub origin/main:

`ainoeviq-oss/Agent-Core:main` -> `fd33f2e15c94c4a51e57b07eaed243211dbe3f8b`

## Remaining cutover gates

1. Commit and push this feature branch normally.
2. Verify exact remote feature SHA.
3. Fast-forward root `main` while preserving `.vscode`.
4. Run fresh root `npm run verify:release`.
5. Push `main` and verify exact remote SHA.
6. Run real Codespace `ensure-running --repair --phase attach` from integrated source.
7. Verify local HEAD == origin/main == `connection.json.sourceCommit`.
8. Verify package version == live `/health.version` == `agent_core_status.version` == `connection.json.sourceVersion`.
9. Publish a new patch release instead of rewriting immutable v0.5.2 if the integrated fix changes the stable source.
