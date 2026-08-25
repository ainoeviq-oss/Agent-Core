# Task 22 Checkpoint — Staged Live Rollout and Canary

Date: 2026-08-25 UTC / 2026-08-26 Asia/Jakarta
Branch: `feature/local-continuity-execution-fabric-admin`
Base accepted feature commit before Task 22: `490c2b9`
Live root: `F:\Projects\Agent-Core`
Feature worktree: `F:\Projects\Agent-Core\.worktrees\local-continuity-execution-fabric-admin`

## Status

**PASS — Task 22 staged rollout completed.**

This checkpoint does **not** declare the project globally stable. Task 23 final regression, integration, clean-checkout verification, recovery/security/performance gates, final live verification, and remote push remain outstanding.

No GitHub push occurred during Task 22.

## Pre-rollout safety evidence

Before live migration:

- live DMF was schema v1 with `PRAGMA quick_check = ok`;
- an explicit consistent SQLite backup was created with the same `VACUUM INTO` primitive used by the memory worker:
  - `runtime\memory\backups\agent-core-memory.2026-08-25T16-48-12-225Z.pre-continuity-execution-live-canary.sqlite`;
- source and backup were both user_version 1 and passed quick check;
- credential hash evidence was recorded in:
  - `runtime\continuity-execution-deployment\pre-rollout-auth-hashes.json`;
- the custom ChatGPT key file, `runtime\data\keys.json`, and `runtime\data\oauth.json` were hashed without printing contents;
- the control-plane key remained ACL-protected and unreadable by the service identity; permissions were not changed.

The old root `dist` was preserved before binary cutover:

- `runtime\continuity-execution-deployment\root-dist-v4-backup-2026-08-25T17-04-47-552Z`
- 100 files / 526073 bytes.

## Stage A — v5 + continuity live, execution disabled

### First full-tray attempt

The first detached full-tray helper was **not accepted**. Its log showed the old bundle went down, the feature tray was attempted, and health did not become ready within its bounded window. The existing launcher/tray later restored the old v4 root binary.

This failure was treated as rollout evidence, not ignored.

### Isolated migration proof

Before retrying live, the validated feature binary was run on an isolated port against a copy of the pre-rollout v1 DMF backup:

- v5 binary booted successfully;
- copied DMF migrated v1 -> v2;
- `PRAGMA quick_check = ok`;
- continuity was enabled, healthy, and snapshot-ready;
- execution remained disabled exactly as Stage A required.

Evidence:

- `runtime\continuity-execution-deployment\stage-a-isolated-canary.json`
- isolated canary listener was later stopped gracefully and port 9765 was verified clean.

### Live Stage A cutover

A safer reversible cutover was used:

1. fresh feature build completed;
2. feature `dist` was copied into live root `dist` after backing up v4 `dist`;
3. only the Agent Core child was gracefully restarted through the already-running root tray; the tray and tunnel were retained;
4. root tracked source files remained unchanged.

Live Stage A acceptance:

- capability stage: `v5-local-continuity-execution-fabric`;
- MCP surface: 43 tools including all continuity/execution tools;
- DMF: schema v2, healthy, integrity `ok`;
- continuity: enabled, healthy, snapshot-ready;
- execution: disabled;
- tunnel `/readyz`: HTTP 200;
- authenticated principal remained `chatgpt-production`.

The live migration also produced the automatic pre-migration backup:

- `runtime\memory\backups\agent-core-memory.2026-08-25T17-07-29-297Z.pre-migration-v1-to-v2.sqlite`.

Evidence:

- `runtime\continuity-execution-deployment\stage-a-live-cutover.json`
- `runtime\continuity-execution-deployment\stage-a-post-reconnect-auth-hashes.json`.

## Stage B — explicit execution opt-in

### First opt-in attempt rejected

The first Stage B child was started after only observing port 8765 become free. Execution became healthy, but DMF reported `database is locked` and continuity degraded.

This attempt was **rejected immediately** and not counted as a pass.

Root cause: listener release occurred before the previous Node process had fully exited and released SQLite/WAL ownership.

### Clean-lock retry

The retry added a stronger barrier:

1. request graceful stop;
2. wait for the old Node PID to exit completely;
3. require a quiet period with no 8765 listener;
4. run offline `PRAGMA quick_check` against live DMF;
5. only then start the temporary child with `AGENT_CORE_EXECUTION_ENABLED=true`.

Evidence log:

- `runtime\continuity-execution-deployment\stage-b-retry-clean-lock-helper.log`
- old Agent PID: 4112;
- old PID fully exited;
- offline DMF quick check: `ok`;
- temporary explicit-opt-in Agent PID: 14460;
- tunnel PID remained 4544.

After retry:

- DMF healthy / schema 2 / integrity `ok`;
- continuity healthy / snapshot-ready;
- execution enabled / healthy / integrity `ok`;
- tunnel ready HTTP 200.

### Stage B live dependency/wake canary

Evidence:

- `runtime\continuity-execution-deployment\stage-b-live-canary.json`
- run: `4c11d2cd-8b10-4f93-9446-a0e242fabefc`.

Canary graph:

- A and B independent;
- C depends only on A;
- a fresh same-principal route adds E after the run is active, with E depending on C.

Observed:

- MCP tool count = 43;
- all 8 execution tools present;
- all `execution_wait` calls returned persisted events without timeout;
- A wait returned in 841 ms;
- B was still running when A completed;
- C completed after A and while B was still running;
- fresh route observed the active owned run;
- fresh route added E successfully;
- E completed while B was still running;
- all A/B/C/E succeeded on attempt 1;
- final run state `completed`;
- bounded stdout logs were retrievable and contained the expected factual markers.

Factual timestamps:

- A: 1787678285571
- C: 1787678285970
- E: 1787678286584
- B: 1787678292988

Therefore `A < C < E < B`, proving dependency-correct concurrency rather than global serialization.

## Stage C — execution enabled by default

### TDD config gate

A config test was changed first to require production default execution `enabled: true`.

RED evidence:

- `tests/config.test.ts` failed exactly because received `enabled: false` while expecting `true`.

Production change:

- `src/config.ts` now defaults `AGENT_CORE_EXECUTION_ENABLED` to `true`;
- explicit `AGENT_CORE_EXECUTION_ENABLED=false` remains supported for diagnostics/rollback.

GREEN evidence:

- config tests 2/2 passed.

### Smoke contract correction

The live smoke test then failed for a genuine stale assertion:

- expected 23 tools, live v5 correctly exposed 43.

`scripts/smoke-test.mjs` was corrected to assert 43 tools. The rerun passed and verified health, unauthorized rejection, v0.5.0 initialization, v5 stage, all 43 tools, routing, required skill-load behavior, and fabricated-route rejection.

### Default-on test lifecycle regression

Focused tests initially exposed five teardown failures with `EBUSY` on execution SQLite files. Assertions themselves passed.

Root cause:

- some older low-level MCP/continuity fixtures inherited the now-enabled execution default;
- their teardown closed HTTP + DMF but did not close execution;
- production `startAgentCoreService().close()` already used the correct `execution.close() -> memory.close()` lifecycle.

The affected test fixtures were aligned with the production/reference lifecycle:

- `tests/mcp-integration.test.ts` now tracks runtimes and closes execution before memory;
- `tests/continuity-checkpoint.test.ts` now closes execution before memory.

Regression evidence:

- isolated repaired pair: 2/2 files, 8/8 tests PASS;
- final focused Stage C set: 6/6 files, 21/21 tests PASS;
- `git diff --check`: PASS;
- fresh `npm run build`: PASS.

### Default-on live watchdog cutover

The feature was rebuilt and copied to root `dist`.

Pre-restart validation:

- root/feature `dist\index.js` SHA-256 matched;
- compiled `dist\config.js` contained the default-on execution marker;
- root tracked source remained unchanged;
- user-level and machine-level `AGENT_CORE_EXECUTION_ENABLED` overrides were unset;
- the tray script does not set `AGENT_CORE_EXECUTION_ENABLED`.

A detached helper requested graceful shutdown of the temporary Stage B child and did **not** start another Node process itself. The existing root tray watchdog had to recover the service.

Evidence:

- `runtime\continuity-execution-deployment\stage-c-default-enabled-watchdog-helper.log`
- `runtime\continuity-execution-deployment\stage-c-default-enabled-live.json`.

Observed transition:

- temporary Stage B Agent PID: 14460;
- stale pre-recovery tray-state PID: 21368;
- temporary PID exited cleanly;
- watchdog-created Agent PID: **10664**;
- post-restart tray-state PID: **10664**;
- tray origin: `started`;
- tunnel PID remained **4544**;
- Agent command line: root `dist\index.js`;
- tunnel `/readyz`: HTTP 200;
- helper `accepted: true`;
- helper `explicitExecutionOverride: false`.

Post-restart health:

- DMF enabled / healthy / schema 2 / integrity `ok`;
- continuity enabled / healthy / snapshot-ready;
- execution enabled / healthy / schema 1 / integrity `ok` / active runs 0.

This proves execution is now enabled by the normal production default and survives ownership handoff back to the tray watchdog.

### Stage C default-on live canary

Evidence:

- `runtime\continuity-execution-deployment\stage-c-live-canary.json`
- run: `73d281fc-62ef-4781-a6d2-c8bccab95fd7`.

Observed:

- tool count = 43;
- all execution tools present;
- different original/fresh route contexts;
- all waits returned without timeout;
- A wait elapsed 830 ms;
- B was running when A completed;
- C completed while B was running;
- fresh route observed the active run and added E;
- E completed while B was running;
- dependency timing valid;
- final state `completed`;
- A/B/C/E all succeeded on attempt 1;
- factual stdout logs were retrievable.

Timestamps:

- A: 1787679115990
- C: 1787679116382
- E: 1787679117007
- B: 1787679123406

Again `A < C < E < B`.

## Authentication / credential invariant note

The original plan asked to compare credential-file hashes. Task 22 found an important distinction between immutable credential material and mutable authentication runtime state.

Evidence:

- `runtime\continuity-execution-deployment\stage-c-auth-invariants.json`.

Results:

- custom Agent Core ChatGPT key file: **byte-identical to pre-rollout**;
- authenticated key identity remains `chatgpt-production`, ID unchanged;
- stable key-store material matches the local `runtime\data-current\keys.json` snapshot;
- `keys.json` full-file hash is not invariant because successful key verification deliberately updates `lastUsedAt` in `src/auth/key-store.ts`;
- `oauth.json` full-file hash is not invariant because it is an operational OAuth store containing mutable clients, authorization codes, access tokens, refresh tokens, expiries, and revocation/session state;
- the Stage A OAuth reconnect and later authenticated canaries therefore legitimately changed full-file hashes;
- the control-plane key remained unreadable by the service identity and its permissions were not modified.

No secret value was printed, promoted to DMF, or committed.

For Task 23, immutable credential material/identity must remain stable; full-file equality of deliberately mutable auth stores is not a valid stability invariant.

## Root/user-file preservation

The root branch was not merged or reset during Task 22. Live deployment used reversible build artifacts only.

User/project untracked architecture docs were preserved. The temporary smoke artifact `route-proof.txt` was removed after verification.

No `reset --hard`, destructive clean, clone, or remote push was used.

## Task 22 acceptance

Task 22 acceptance criteria are met:

- pre-migration backup exists and validates;
- live DMF migrated to schema v2 and remains healthy;
- continuity is live and deterministic/snapshot-ready;
- Stage A execution-disabled rollout verified;
- Stage B explicit execution opt-in verified with a dependency/wake/cross-route canary;
- a real startup SQLite lock race was detected, rejected, root-caused, and eliminated with a PID-exit/offline-integrity barrier;
- Stage C execution default-on implemented with TDD;
- v5 43-tool smoke contract corrected and passing;
- test fixture lifecycle regressions caused by default-on were root-caused and repaired;
- normal tray watchdog restart now owns the default-enabled live process;
- tunnel remained ready;
- live Stage C canary passed;
- credential material/identity is preserved with mutable auth-store behavior explicitly accounted for;
- no remote push occurred.

**Decision: advance to Task 23 Final Regression, Integration, Stability Certification, and only then GitHub push.**
