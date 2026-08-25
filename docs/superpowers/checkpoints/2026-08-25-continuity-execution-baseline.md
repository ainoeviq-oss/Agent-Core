# Agent Core — Local Continuity + Execution Fabric Baseline

Date: 2026-08-25 (Asia/Jakarta)
Feature branch: `feature/local-continuity-execution-fabric`
Feature worktree: `F:\Projects\Agent-Core\.worktrees\local-continuity-execution-fabric`
Baseline HEAD: `c92a429ea6125e7001fb7c16e45aa0e2c23a9fba`
Safety branch: `safety/pre-continuity-execution-20260825-1245`

## Baseline decision

**TASK 1 BASELINE: GREEN.** The feature worktree is isolated, dependencies are installed, build passes, and the complete baseline suite passes after reproducing the main checkout's ignored tunnel-profile environment.

No production source, OAuth/key state, or live DMF schema was changed to establish this baseline.

## Isolation proof

- Main checkout remained on `planning/agent-core-tray-manager` at `c92a429`.
- `.worktrees` existed before feature creation and is Git-ignored.
- Feature branch did not exist before creation.
- Worktree path did not exist before creation.
- Worktree was created from exact baseline `c92a429`.
- Existing untracked architecture/plan/checkpoint files in the main checkout were not deleted, reset, staged, or moved.
- No `git reset --hard` was used.

## Dependency setup

Command: `npm ci`

- packages added: 142
- packages audited: 143
- vulnerabilities: 0
- exit code: 0
- npm cache redirected under `F:\Projects\Agent-Core\runtime\continuity-execution-bootstrap\npm-cache`

## Build baseline

Command: `npm run build`

- result: PASS
- exit code: 0
- MCP server version from built output: `0.5.0`
- `dist/index.js` bytes: 4400
- `dist/index.js` SHA-256: `9DFD36E402EFDA3343BAD3B933897B95BBC677A2AADF1589B5480E8279BE693A`

## Authentication-state hash baseline

Only file metadata and cryptographic hashes were read. Credential contents were never printed or copied into this checkpoint.

- `runtime\data\keys.json`
  - bytes: 428
  - SHA-256: `2F67AF7DF6ADEE04B3C88EC9A940C1A1BAA441D47ED24C47A2B8953870ECEEE9`
- `runtime\data\oauth.json`
  - bytes: 10197
  - SHA-256: `D8A5598BE126063D2662F2E37655E23190971CC517153BC5FB13E2D3403C335F`

These are hash-only rollout sentinels for later comparison; they are not authentication material.

## Worktree baseline test diagnosis

The first complete worktree test run produced exactly one failure:

`tests/unified-launcher.test.ts > Agent Core portable tunnel profile > keeps tunnel secret references portable across project moves`

The failure was `ENOENT` for:

`F:\Projects\Agent-Core\.worktrees\local-continuity-execution-fabric\tunnel-client\agent-core.yaml`

### Root cause

The source checkout contains `tunnel-client\agent-core.yaml`, but the file is intentionally Git-ignored/untracked. Therefore a fresh Git worktree cannot receive it from commit `c92a429`, even though the same test passes in the main checkout where the ignored operator profile is present.

Evidence:

- main profile exists: true
- profile is not tracked by Git
- profile is Git-ignored
- worktree profile was initially absent
- main profile SHA-256: `DD97B521905E2B918A050F743C0F2420659C12088BF26F505AFED0A0C3C1DC0A`

### Minimal environment restoration

Only the ignored tunnel profile reference file was copied from the main checkout into the feature worktree. No referenced secret file and no secret value was copied or printed.

After copy:

- destination profile SHA-256 matched source exactly
- destination remained Git-ignored
- `git status` remained clean
- focused `tests/unified-launcher.test.ts`: **4/4 PASS**

This proves the first failure was an incomplete ignored runtime fixture/environment, not a feature-source regression.

## Final complete worktree baseline

Full rerun after environment restoration:

- Test files: **48 passed / 48**
- Tests: **169 passed / 169**
- exit code: **0**
- Vitest duration: **107.36 s**
- `tests/tray-manager.test.ts`: **22/22 PASS**
- `tests/unified-launcher.test.ts`: **4/4 PASS**
- current MCP integration contract: exactly **31** routing + DMF tools

Test TEMP/TMP was redirected to an F:-backed directory under `runtime\continuity-execution-bootstrap`.

## Async / wake execution method used during bootstrap

Independent build/test/install commands were launched through Agent Core `start_process`. A separate PowerShell `Wait-Process` worker was used as a temporary OS-level wake surrogate so shell code did not use busy-loop polling.

This surrogate is temporary. Native persisted event-driven wake is an explicit deliverable of execution Tasks 13–14 (`waitForEvent` / `execution_wait`) and becomes authoritative after those tasks are implemented and verified.

## Ready state

The feature branch is now safe to begin Task 2 under strict red-green-refactor TDD. Production continuity code must not be written before its focused test has been observed failing for the expected missing-contract reason.
