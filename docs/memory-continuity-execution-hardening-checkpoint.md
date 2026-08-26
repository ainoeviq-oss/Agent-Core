# Agent Core Memory / Continuity / Execution Hardening — Durable Checkpoint Note

This file is the durable comparison note for:

- root checkout: `/workspaces/Agent-Core` (`main`)
- implementation worktree: `/workspaces/Agent-Core/.worktrees/memory-continuity-execution-hardening`
- implementation branch: `feat/memory-continuity-execution-hardening`
- writable GitHub remote: `origin = https://github.com/ainoeviq-oss/Agent-Core.git`
- parent remote: `upstream = https://github.com/rendevouz999/Agent-Core`
- plan source of truth: `/workspaces/Agent-Core/docs/superpowers/plans/2026-08-26-agent-core-memory-continuity-execution-hardening.md`

## Purpose

Prevent duplicate implementation, context drift, and accidental divergence between the root checkout, isolated implementation worktree, and durable GitHub checkpoints. This note MUST be updated after each completed plan task before the next task begins.

## Guardrails

- Never use GitHub Actions / CI.
- Never force push.
- Never expose secrets/tokens/API keys.
- Do not touch the Windows/local Agent Core runtime or databases.
- Keep `/workspaces/Agent-Core` root `main` unchanged until final verified integration.
- Every completed plan task after this checkpoint gets its own commit and normal push to `origin/feat/memory-continuity-execution-hardening`.
- Final integration to root `main` happens only after full local verification.

## Checkpoint 000 — Catch-up for Tasks 1–15

Reason: Tasks 1–15 were already implemented before the per-task commit/push checkpoint policy was explicitly requested. This is the one catch-up checkpoint; Task 16 onward is one task = one commit + one push.

### Plan objective

Harden memory, continuity, deterministic execution evidence, multi-command scheduling, and wake behavior into one factual, project-isolated, evidence-backed closed loop.

### Completed task range

- Task 1 — isolated implementation worktree
- Task 2 — baseline capture
- Task 3 — memory/execution health-state consistency
- Task 4 — actual project-root resolution
- Task 5 — project identity propagation
- Task 6 — cross-project isolation regressions
- Task 7 — stale/open continuity reconciliation
- Task 8 — natural continuation recognition + duplicate prevention
- Task 9 — machine-readable memory/continuity directives
- Task 10 — durable structured outcome/constraint checkpoint promotion
- Task 11 — declared execution artifact contract
- Task 12 — bounded workspace-safe artifact verifier + SHA256
- Task 13 — process state vs evidence state separation
- Task 14 — required evidence failure prevents final node success/dependency release
- Task 15 — bounded merged execution evidence summary in `execution_status`

### Verification evidence before commit

```text
npm run build                                                   PASS
12 focused test files                                           PASS
78 focused tests                                                PASS
failures                                                        0
```

Focused suites:

```text
tests/memory-recovery.test.ts
tests/execution-unified-lifecycle.test.ts
tests/workspace.test.ts
tests/route-context-store.test.ts
tests/project-scope-routing.test.ts
tests/continuity-resume.acceptance.test.ts
tests/continuity-checkpoint.test.ts
tests/execution-dag.test.ts
tests/execution-evidence.test.ts
tests/execution-runner.test.ts
tests/execution-schema.test.ts
tests/execution-mcp.test.ts
```

### Repository comparison before catch-up commit

| Surface | Ref / state |
| --- | --- |
| Root `/workspaces/Agent-Core` HEAD | `a8ae93affc053c0fe953d52f676857a84845400a` |
| Worktree HEAD before checkpoint commit | `a8ae93affc053c0fe953d52f676857a84845400a` + verified uncommitted Tasks 1–15 changes |
| `origin/main` | `a8ae93affc053c0fe953d52f676857a84845400a` |
| `origin/feat/memory-continuity-execution-hardening` | not created yet |
| `upstream/main` | `663f78356308017c087aaa3bf912f3c1479420e4` |

### Next task

Task 16 — wire coalesced `node.output_available` from real runner stdout/stderr output while preserving persist-before-signal and avoiding event flooding.

## Update protocol for every next task

For Task N:

1. Read this note and the canonical plan section.
2. Confirm root/main, worktree HEAD, `origin/main`, and remote feature SHA.
3. Write RED regression test.
4. Implement minimal GREEN behavior.
5. Run focused verification + `git diff --check`.
6. Update this note with Task N result, changed files, test evidence, commit SHA placeholder.
7. Commit exactly that task checkpoint.
8. Push normal non-force to `origin/feat/memory-continuity-execution-hardening`.
9. Resolve and record the exact remote feature SHA.
10. Only then begin Task N+1.

## Checkpoint 016 — Task 16: Real runner output-available wake wiring

### Prior durable checkpoint resolved

```text
root/main HEAD   = a8ae93affc053c0fe953d52f676857a84845400a
origin/main      = a8ae93affc053c0fe953d52f676857a84845400a
worktree HEAD    = 61214b019af4d5328192f3702d9ad6bd7cab6ed1
origin/feature   = 61214b019af4d5328192f3702d9ad6bd7cab6ed1
```

### Behavior implemented

Real `ExecutionCommandRunner` stdout/stderr chunks now emit metadata-only availability callbacks with:

```text
stream
offset
nextOffset
chunkBytes
```

The scheduler routes those callbacks through the existing `ExecutionEventJournal` as `node.output_available`. The journal remains the single coalescing and persist-before-signal authority. No raw stdout/stderr content is stored in the event payload. Pending output notification work is settled before runner terminal completion, so an already-observed output notification is not overtaken by the terminal node event.

Observer failure is non-authoritative and cannot rewrite factual process success/failure.

### Changed files

```text
src/execution/runner.ts
src/execution/scheduler.ts
tests/execution-wake.test.ts
```

### RED evidence

Real-runner `execution_wait(eventTypes=[node.output_available])` timed out because no production runner caller invoked `recordOutputAvailable()`.

### GREEN verification

```text
npm run build                                                   PASS
execution-wake real-runner focused regression                  PASS
execution-wake + execution-runner + execution-scheduler        18/18 PASS
git diff --check                                               PASS
```

### Repository comparison before Task 16 commit

| Surface | Ref / state |
| --- | --- |
| Root `/workspaces/Agent-Core` HEAD | `a8ae93affc053c0fe953d52f676857a84845400a` |
| `origin/main` | `a8ae93affc053c0fe953d52f676857a84845400a` |
| Worktree parent HEAD | `61214b019af4d5328192f3702d9ad6bd7cab6ed1` |
| `origin/feat/memory-continuity-execution-hardening` before Task 16 push | `61214b019af4d5328192f3702d9ad6bd7cab6ed1` |
| Task 16 checkpoint | this commit on `feat/memory-continuity-execution-hardening`; exact resolved SHA is verified immediately after push and recorded by the next checkpoint comparison |

### Next task

Task 17 — prove the complete A/B concurrent wake → inspect A → re-arm wait after latest sequence → inspect B flow with factual evidence.

## Checkpoint 017 — Task 17: Staged A/B wake and evidence proof

### Prior durable checkpoint resolved

```text
root/main HEAD   = a8ae93affc053c0fe953d52f676857a84845400a
origin/main      = a8ae93affc053c0fe953d52f676857a84845400a
worktree HEAD    = d5bd3ae364e091b540190baf06b5afa8ecb89c90
origin/feature   = d5bd3ae364e091b540190baf06b5afa8ecb89c90
```

### Acceptance proof

A real-runner two-node execution with `maxConcurrency=2` proves the required event-driven orchestration contract:

1. independent A and B are simultaneously `running`;
2. A creates a required declared artifact and finishes first;
3. the first bounded wait wakes on persisted `node.succeeded(A)`;
4. B is still `running` when A wakes the waiter;
5. A exposes result-marker v2 with `processState=succeeded`, `evidenceState=verified`, verified artifact path and SHA256;
6. the next wait is armed using the latest observed sequence from A's wake result;
7. B later creates its declared artifact and wakes that second waiter on `node.succeeded(B)` with a strictly later sequence;
8. merged evidence contains deterministic A+B entries, both verified, and a bounded final wait observes persisted `run.completed`.

No caller-side database polling is used. The acceptance uses only bounded event-driven waits and factual persisted status/evidence.

### Changed files

```text
tests/execution-wake.test.ts
```

No production code change was required; Tasks 11–16 already provided the necessary behavior.

### Verification

```text
npm run build                                                   PASS
Task 17 focused real-runner acceptance                          PASS
full tests/execution-wake.test.ts                               7/7 PASS
git diff --check                                               PASS
```

### Repository comparison before Task 17 commit

| Surface | Ref |
| --- | --- |
| Root `/workspaces/Agent-Core` HEAD | `a8ae93affc053c0fe953d52f676857a84845400a` |
| `origin/main` | `a8ae93affc053c0fe953d52f676857a84845400a` |
| Worktree parent HEAD | `d5bd3ae364e091b540190baf06b5afa8ecb89c90` |
| `origin/feat/memory-continuity-execution-hardening` | `d5bd3ae364e091b540190baf06b5afa8ecb89c90` |

### Next task

Task 18 — prove and formalize the deterministic merged run evidence view used for final factual synthesis.

## Checkpoint 018 — Task 18: Deterministic merged run evidence for final synthesis

### Prior durable checkpoint resolved

```text
root/main HEAD   = a8ae93affc053c0fe953d52f676857a84845400a
origin/main      = a8ae93affc053c0fe953d52f676857a84845400a
worktree HEAD    = 3e475c1fa380efc324ccc214854cbd1e4a7686dd
origin/feature   = 3e475c1fa380efc324ccc214854cbd1e4a7686dd
```

### Determinism proof

A real MCP execution is intentionally created with input nodes in reverse order (`B`, then `A`). Both nodes produce required SHA256-verified artifacts and raw stdout sentinels. After persisted `run.completed`:

- `execution_status.evidence.verification = verified`;
- merged evidence is deterministically ordered `A`, `B`, independent of request ordering;
- a second independent `execution_status` read returns an exactly equal evidence object;
- artifact references are ordered consistently with the node evidence and preserve verified SHA256 metadata;
- process state and evidence state remain distinct and verified;
- raw stdout sentinel content is absent from the merged evidence view.

No production code change was needed. The merged evidence builder introduced in Task 15 already satisfies Task 18's deterministic synthesis contract.

### Changed files

```text
tests/execution-mcp.test.ts
```

### Verification

```text
npm run build                                                   PASS
Task 18 deterministic evidence focused acceptance              PASS
full tests/execution-mcp.test.ts                                9/9 PASS
git diff --check                                               PASS
```

### Repository comparison before Task 18 commit

| Surface | Ref |
| --- | --- |
| Root `/workspaces/Agent-Core` HEAD | `a8ae93affc053c0fe953d52f676857a84845400a` |
| `origin/main` | `a8ae93affc053c0fe953d52f676857a84845400a` |
| Worktree parent HEAD | `3e475c1fa380efc324ccc214854cbd1e4a7686dd` |
| `origin/feat/memory-continuity-execution-hardening` | `3e475c1fa380efc324ccc214854cbd1e4a7686dd` |

### Next task

Task 19 — extend the existing `ExecutionMemoryBridge` to promote the verified artifact manifest and exact provenance into deterministic memory without copying raw logs, while preserving degraded-memory queue/replay behavior.

## Checkpoint 019 — Task 19: Verified execution artifact manifest → DMF

### Prior durable checkpoint resolved

```text
root/main HEAD   = a8ae93affc053c0fe953d52f676857a84845400a
origin/main      = a8ae93affc053c0fe953d52f676857a84845400a
worktree HEAD    = 4f3b93c4427aa45b6b53aad319af394a004c7c9c
origin/feature   = 4f3b93c4427aa45b6b53aad319af394a004c7c9c
```

### Behavior implemented

The existing `ExecutionMemoryBridge` is extended rather than replaced. Production runtime wiring now provides the bridge an `ExecutionLogStore`, allowing it to read the already-durable result marker for the exact run/node/attempt.

For result marker v2, successful execution artifact promotion now includes bounded structured facts only:

```text
resultVersion
processState
evidenceState
artifacts[].path
artifacts[].kind
artifacts[].required
artifacts[].exists
artifacts[].verification
artifacts[].size (when applicable)
artifacts[].sha256 (when requested)
```

Exact provenance is retained in value/metadata through taskId, runId, nodeId, attemptId, attemptNo, resultRef, commandHash and eventSequence. Raw stdout/stderr contents are never copied into semantic memory.

Fail-closed behavior was also added: a `node.succeeded` with declared artifacts is not promoted as `execution_verified_evidence` when its durable v2 verified result marker cannot be read.

Legacy behavior remains backward compatible when no log-store is injected or when an old v1 marker is involved. Existing degraded-DMF sync queue/replay remains unchanged and idempotent.

### Changed files

```text
src/execution/memory-bridge.ts
src/runtime/services.ts
tests/execution-memory-bridge.test.ts
```

### RED evidence

The real-runner promotion existed but lacked `resultVersion`, `processState`, `evidenceState`, declared artifact manifest, and exact result/attempt metadata.

### GREEN verification

```text
npm run build                                                   PASS
full tests/execution-memory-bridge.test.ts                      6/6 PASS
verified artifact manifest promotion                            PASS
missing-marker fail-closed regression                           PASS
raw stderr synthetic-secret isolation                           PASS
degraded queue + idempotent replay                              PASS
git diff --check                                               PASS
```

### Repository comparison before Task 19 commit

| Surface | Ref |
| --- | --- |
| Root `/workspaces/Agent-Core` HEAD | `a8ae93affc053c0fe953d52f676857a84845400a` |
| `origin/main` | `a8ae93affc053c0fe953d52f676857a84845400a` |
| Worktree parent HEAD | `4f3b93c4427aa45b6b53aad319af394a004c7c9c` |
| `origin/feat/memory-continuity-execution-hardening` | `4f3b93c4427aa45b6b53aad319af394a004c7c9c` |

### Next task

Task 20 — add an execution-backed semantic completion evidence gate so `task_checkpoint(status=completed)` cannot contradict linked execution evidence, while non-execution semantic tasks remain unchanged.

## Checkpoint 020 — Task 20: Execution-backed semantic completion evidence gate

### Prior durable checkpoint resolved

```text
root/main HEAD   = a8ae93affc053c0fe953d52f676857a84845400a
origin/main      = a8ae93affc053c0fe953d52f676857a84845400a
worktree HEAD    = af63e61cc33be67bd30a1ba603f94c54eba81e73
origin/feature   = af63e61cc33be67bd30a1ba603f94c54eba81e73
```

### Behavior implemented

`task_checkpoint(status=completed)` now checks linked execution truth before continuity persistence. The gate executes before checkpoint/task/frontier/promotion/turn mutations.

Deterministic contract:

- non-execution continuity tasks remain backward-compatible and require no execution reference;
- a continuity task with linked execution runs cannot complete while any linked run is `planned` or `running` (`CONTINUITY_EXECUTION_ACTIVE`);
- once linked execution exists, completion requires at least one explicit `evidence` entry `type="tool", ref="execution:<runId>"` (`CONTINUITY_EXECUTION_EVIDENCE_REQUIRED`);
- every explicit execution reference must resolve to the same principal/project/continuity task, have `state=completed`, and merged `evidence.verification=verified` (`CONTINUITY_EXECUTION_EVIDENCE_INVALID` otherwise);
- failed historical runs that are not cited as completion proof do not automatically poison later verified work, but active runs always block completion;
- process exit 0 with missing required artifact is rejected because its run/evidence are failed.

No completion state is persisted on a rejected gate.

### Changed files

```text
src/execution/service.ts
src/mcp/continuity-tools.ts
tests/continuity-checkpoint.test.ts
```

### RED evidence

Three completion scenarios were incorrectly accepted before the implementation: missing explicit execution ref, required artifact evidence failure, and an active linked run.

### GREEN verification

```text
npm run build                                                   PASS
Task 20 execution completion focused tests                      4 PASS
full continuity-checkpoint + execution-mcp regression           18/18 PASS
non-execution completion regression                             PASS
git diff --check                                               PASS
```

### Repository comparison before Task 20 commit

| Surface | Ref |
| --- | --- |
| Root `/workspaces/Agent-Core` HEAD | `a8ae93affc053c0fe953d52f676857a84845400a` |
| `origin/main` | `a8ae93affc053c0fe953d52f676857a84845400a` |
| Worktree parent HEAD | `af63e61cc33be67bd30a1ba603f94c54eba81e73` |
| `origin/feat/memory-continuity-execution-hardening` | `af63e61cc33be67bd30a1ba603f94c54eba81e73` |

### Next task

Task 21 — upgrade the native Agent Core capability-router skill to make memory, continuity, project identity, multi-command DAG, bounded wake, evidence inspection, retry/cancel, and factual terminal checkpoint behavior mandatory.

## Checkpoint 021 — Task 21: Native Agent Core routing behavior contract

### Prior durable checkpoint resolved

```text
root/main HEAD   = a8ae93affc053c0fe953d52f676857a84845400a
origin/main      = a8ae93affc053c0fe953d52f676857a84845400a
worktree HEAD    = 55db966b0a1019d8f57b513bc1211662f3be2211
origin/feature   = 55db966b0a1019d8f57b513bc1211662f3be2211
```

### Behavior contract implemented

The tracked native router skill now makes the factual execution loop explicit and mandatory while keeping routing jargon invisible to the user. It requires:

- automatic `capability_route` preflight and routed `projectId` preservation;
- inspection of `memoryDirective`, `memorySummary`, `blockingGuardrails`, `priorFailures`, `relatedDecisions`;
- inspection of `continuityDirective`, `continuitySnapshot`, and `continuityResumeCandidates` before creating duplicate semantic work;
- deterministic resume/reuse when one factual continuation candidate exists;
- two-or-more independent commands to prefer one `execution_create` DAG with only true `dependsOn` edges;
- `execution_start`, continued useful independent work while nodes run, and `expectedArtifacts` for semantic outputs that require verification;
- bounded event-driven `execution_wait` only when needed, never busy polling;
- wake -> `execution_status` -> verified evidence inspection;
- re-arm the next wait with `afterSequence` from the latest observed `lastEventSequence`;
- explicit `execution_retry` / `execution_cancel` rather than hidden attempt rewriting;
- never infer success from elapsed time, PID disappearance, raw output prose, or exit code alone;
- deterministic merged evidence synthesis using `evidence.verification`;
- terminal `task_checkpoint` with factual evidence/frontier and explicit `execution:<runId>` for execution-backed completion.

### Changed files

```text
plugin/agent-core/skills/agent-core-capability-router/SKILL.md
tests/agent-core-router-skill.test.ts
```

### RED evidence

The original tracked router skill had no `projectId`, memory/continuity inspection contract, execution DAG/wake primitives, merged evidence contract, or execution-backed checkpoint rule. All three new behavior-contract test groups failed.

### GREEN verification

```text
tests/agent-core-router-skill.test.ts                           3/3 PASS
npm run build                                                   PASS
git diff --check                                               PASS
```

### Repository comparison before Task 21 commit

| Surface | Ref |
| --- | --- |
| Root `/workspaces/Agent-Core` HEAD | `a8ae93affc053c0fe953d52f676857a84845400a` |
| `origin/main` | `a8ae93affc053c0fe953d52f676857a84845400a` |
| Worktree parent HEAD | `55db966b0a1019d8f57b513bc1211662f3be2211` |
| `origin/feat/memory-continuity-execution-hardening` | `55db966b0a1019d8f57b513bc1211662f3be2211` |

### Next task

Task 22 — rebuild the generated Agent Core plugin package and prove exact tracked/generated core-skill parity plus secret/runtime exclusion.

## Checkpoint 022 — Task 22: Generated plugin rebuild and exact skill parity

### Prior durable checkpoint resolved

```text
root/main HEAD   = a8ae93affc053c0fe953d52f676857a84845400a
origin/main      = a8ae93affc053c0fe953d52f676857a84845400a
worktree HEAD    = 3441d6434daaf98908d6a97c5b9d804ab4cd87ae
origin/feature   = 3441d6434daaf98908d6a97c5b9d804ab4cd87ae
```

### Package build facts

The Codespace checkout currently has no external capability registry at `/workspaces/Agent-Core/capabilities/registry/catalog.json`, so an unqualified `npm run build:plugin` correctly failed rather than fabricating a registry. The actual ignored generated package was then rebuilt successfully with an explicit temporary empty local registry. This produces the two tracked Agent Core core skills only. Separately, the existing deterministic plugin-package fixture still proves that audited `native_ready` skills are imported only with verified provenance/license gates.

Actual generated output:

```text
plugin/agent-core/generated/agent-core-package.json
plugin/agent-core/generated/skills/agent-core-capability-router/SKILL.md
plugin/agent-core/generated/skills/agent-core-github/SKILL.md
```

The generated directory remains intentionally ignored by repository policy and is not staged as durable source.

### Exact parity evidence

```text
tracked router SHA256   = cd9620f4420cdc6a9c232dd79e954f4aa639dce4b554aec1d63efd208d1b0762
generated router SHA256 = cd9620f4420cdc6a9c232dd79e954f4aa639dce4b554aec1d63efd208d1b0762
cmp result              = BYTE_IDENTICAL
```

The plugin-package test now enforces byte-for-byte equality for both tracked core skills, not merely keyword presence.

### Secret/runtime exclusion

Generated package paths were scanned and contain no `secrets`, `runtime`, `cache`, `gh-token`, `packages-token`, `oauth.json`, or `control-plane-api-key` path. Package metadata remains credential-free. The fixture package test also checks generated paths for those forbidden classes.

### Changed tracked files

```text
tests/plugin-package.test.ts
```

### Verification

```text
npm run build                                                   PASS
tests/plugin-package.test.ts                                    4/4 PASS
tests/agent-core-router-skill.test.ts                           3/3 PASS
actual local generated package rebuild                          PASS
tracked/generated router byte parity                            PASS
forbidden generated-path scan                                   PASS
git diff --check                                               PASS
```

### Repository comparison before Task 22 commit

| Surface | Ref |
| --- | --- |
| Root `/workspaces/Agent-Core` HEAD | `a8ae93affc053c0fe953d52f676857a84845400a` |
| `origin/main` | `a8ae93affc053c0fe953d52f676857a84845400a` |
| Worktree parent HEAD | `3441d6434daaf98908d6a97c5b9d804ab4cd87ae` |
| `origin/feat/memory-continuity-execution-hardening` | `3441d6434daaf98908d6a97c5b9d804ab4cd87ae` |

### Next task

Task 23 — run the required focused local regression groups across memory health, project isolation, continuity, execution evidence/DAG/wake/bridge, plugin behavior, and secret-safety surfaces; no GitHub Actions/CI.

## Checkpoint 023 — Task 23: Focused local regression sweep

### Prior durable checkpoint resolved

```text
root/main HEAD   = a8ae93affc053c0fe953d52f676857a84845400a
origin/main      = a8ae93affc053c0fe953d52f676857a84845400a
worktree HEAD    = 96f4d9428841faa4ac26fd51c2e71e345f10320e
origin/feature   = 96f4d9428841faa4ac26fd51c2e71e345f10320e
```

### Persisted regression DAG

Execution run:

```text
runId             = bfb2f36f-d745-4ed5-a65c-43b1f9b558ae
maxConcurrency    = 4
terminal event    = run.completed
lastEventSequence = 23
```

The first attempt to request concurrency 5 was rejected with `EXECUTION_CONCURRENCY_INVALID` before any run/process was created. The corrected DAG used the configured maximum 4: four independent nodes started concurrently and the fifth independent node filled the first available slot automatically.

All five persisted nodes completed `succeeded`:

| Node | Result | Factual evidence |
| --- | --- | --- |
| `build` | succeeded | `npm run build` / TypeScript compile PASS |
| `memory` | succeeded | 8 test files, 32 tests PASS |
| `continuity` | succeeded | 9 test files, 60 tests PASS |
| `execution` | succeeded | 13 test files, 72 tests PASS |
| `plugin-secret` | succeeded | 3 test files, 13 tests PASS |

Focused aggregate:

```text
33 test files PASS
177 tests PASS
0 failures
TypeScript build PASS
```

### Focused surfaces covered

Memory group covers health/lifecycle, recovery + WAL crash semantics, v1→v2 memory migration backup, redaction, awareness, operational audit, project routing, and MCP memory behavior.

Continuity/project group covers actual project identity, cross-project rejection, route state, checkpoint promotion/completion gate, deterministic continuation/reuse, stale-turn reconciliation, restart/resume, snapshot/store/type determinism, and principal isolation.

Execution group covers DAG validation/concurrency, declared artifact evidence, result markers v1/v2, required-artifact fail-closed semantics, runner, scheduler, schema v2 + migration, persistent store, coalesced wake, staged A/B wake, deterministic merged evidence, MCP ownership/dynamic/retry/cancel, Execution→DMF manifest promotion, recovery, degraded subsystem isolation, and cross-session execution resume.

Plugin/secret group covers tracked router behavior contract, generated package parity/safety, and synthetic GitHub credential redaction across MCP errors, memory, and audit logs.

### Source impact

No source regression was found and no production/test change was needed for Task 23. Only this durable checkpoint Note changes.

### Verification

```text
execution run bfb2f36f-d745-4ed5-a65c-43b1f9b558ae        completed
all 5 DAG nodes                                                succeeded
33 focused test files                                          PASS
177 focused tests                                              PASS
npm run build                                                   PASS
git diff --check                                               PASS
working tree before Note update                                clean
```

### Repository comparison before Task 23 commit

| Surface | Ref |
| --- | --- |
| Root `/workspaces/Agent-Core` HEAD | `a8ae93affc053c0fe953d52f676857a84845400a` |
| `origin/main` | `a8ae93affc053c0fe953d52f676857a84845400a` |
| Worktree parent HEAD | `96f4d9428841faa4ac26fd51c2e71e345f10320e` |
| `origin/feat/memory-continuity-execution-hardening` | `96f4d9428841faa4ac26fd51c2e71e345f10320e` |

### Next task

Task 24 — run the full local build/test/verification gates from the feature worktree, including brand and local release checks only after confirming those scripts cannot dispatch GitHub Actions/CI.

## Checkpoint 024 — Task 24: Full local verification and release-consistency gates

### Prior durable checkpoint resolved

```text
root/main HEAD   = a8ae93affc053c0fe953d52f676857a84845400a
origin/main      = a8ae93affc053c0fe953d52f676857a84845400a
worktree HEAD    = 49a5bb5eb534366a27aeeebab9aae55c649c41e8
origin/feature   = 49a5bb5eb534366a27aeeebab9aae55c649c41e8
```

### CI-safety audit

Before running the canonical release verification, the local scripts were inspected directly:

```text
verify         = npm run check:brand && npm run build && npm test
verify:release = npm run verify && node scripts/release/check-release.mjs && node scripts/release/check-doc-links.mjs
```

No `github_actions`, `gh workflow`, `gh run`, `workflow_dispatch`, or `actions/` execution reference exists in the local verification scripts. `check-release.mjs` only inspects source/version/tracked-path invariants with local Node + Git reads. `check-doc-links.mjs` only validates local tracked markdown links.

`package:release` is a Windows PowerShell packaging command and was intentionally not executed in Codespace.

### Canonical full local gate

Executed from the feature worktree:

```text
npm run verify:release
```

Fresh result:

```text
Agent Core brand scan                               PASS
TypeScript build                                    PASS
Test Files                                          80 passed, 1 skipped (81 total)
Tests                                               350 passed, 32 skipped (382 total)
Failures                                            0
Release version/package-lock/server-version match   PASS (0.5.1)
CHANGELOG current-version section                   PASS
README version-neutral check                        PASS
forbidden tracked runtime/secret paths              PASS
historical docs/superpowers tracked                 0
tracked files inspected                             234
tracked markdown files checked                      24
relative links checked                              22
missing/escaping relative links                     0
```

The 32 skipped tests are existing platform/performance-gated cases (not failures), including Windows tray/launcher coverage that remains active on Windows and bounded performance tests not enabled in this environment.

### Source impact

No regression was found. Task 24 requires no source/test patch; only this durable verification checkpoint is added.

### Repository comparison before Task 24 commit

| Surface | Ref |
| --- | --- |
| Root `/workspaces/Agent-Core` HEAD | `a8ae93affc053c0fe953d52f676857a84845400a` |
| `origin/main` | `a8ae93affc053c0fe953d52f676857a84845400a` |
| Worktree parent HEAD | `49a5bb5eb534366a27aeeebab9aae55c649c41e8` |
| `origin/feat/memory-continuity-execution-hardening` | `49a5bb5eb534366a27aeeebab9aae55c649c41e8` |

### Next task

Task 25 — run the final isolated acceptance matrix for secret leakage, restart/recovery/migration, deterministic continuity/project isolation, execution evidence/wake, plugin package safety, and restart persistence of schema-v2 declared execution artifacts.

## Checkpoint 025 — Task 25: Isolated recovery, determinism, secret, and multi-project acceptance

### Prior durable checkpoint resolved

```text
root/main HEAD   = a8ae93affc053c0fe953d52f676857a84845400a
origin/main      = a8ae93affc053c0fe953d52f676857a84845400a
worktree HEAD    = e020f373e254a3f65d0fa8968ab97c2fee0584d7
origin/feature   = e020f373e254a3f65d0fa8968ab97c2fee0584d7
```

### New restart-durability acceptance

Coverage audit found that schema-v2 migration tests proved the new column and legacy default behavior, but did not explicitly prove a newly declared `expectedArtifacts` contract survives a real `ExecutionService` close/reopen boundary and is still enforced when the persisted planned run is later started.

New acceptance test:

```text
tests/execution-restart-artifact.acceptance.test.ts
```

It proves:

1. a planned run persists a required SHA256 file declaration;
2. the first ExecutionService closes cleanly;
3. a fresh service reopens the same planned graph and returns the exact same `expectedArtifacts` declaration;
4. the reopened service starts the already-persisted run;
5. the produced file is verified through result-marker v2 with process success + evidence verification + SHA256;
6. a third fresh service reopen still reads the same completed run, declared artifact contract, and verified evidence.

Focused build + this acceptance: PASS (1/1).

### Persisted Task 25 acceptance DAG

```text
runId             = fa6e5959-51f9-484c-86ee-c7f5e1f02656
maxConcurrency    = 4
terminal event    = run.completed
lastEventSequence = 19
```

All four independent acceptance nodes started concurrently and completed `succeeded`:

| Node | Test files | Tests | Covered acceptance |
| --- | ---: | ---: | --- |
| `persistence-recovery` | 6 | 27 | memory backup/restore, memory v1→v2 migration backup, WAL crash recovery, memory restart health, execution schema v2, execution crash/restart recovery, declared-artifact restart durability, continuity cross-session resume |
| `isolation-determinism` | 5 | 30 | actual routed project identity, cross-project rejection, continuity store/snapshot/type determinism, principal isolation, deterministic merged execution evidence, MCP ownership/retry/cancel |
| `wake-bridge-completion` | 4 | 24 | coalesced output wake, staged A/B wake/re-arm, verified Execution→DMF manifest, secret-free promotion, semantic execution completion gate, execution continuity resume |
| `secret-plugin` | 4 | 14 | memory redaction, GitHub credential redaction across MCP/memory/audit, exact generated plugin parity, forbidden path safety, router behavior contract |

Acceptance aggregate:

```text
19 test files PASS
95 tests PASS
0 failures
run.completed
```

### Key fail-closed proofs

- SQLite integrity/migration/restore never fabricates state.
- Old open turns become interrupted rather than completed.
- Missing terminal result marker never implies success.
- Required declared artifact survives restart and remains authoritative.
- Routed project B cannot operate on project A, including declared evidence paths.
- Cross-principal continuity/execution remains hidden.
- Raw stdout/stderr secret sentinels are not copied into DMF or merged evidence.
- Execution-backed `task_checkpoint(completed)` cannot contradict active/failed/unverified execution.
- Generated plugin package excludes secret/runtime/cache paths.

### Changed files

```text
tests/execution-restart-artifact.acceptance.test.ts
```

### Verification

```text
npm run build                                                   PASS
restart-artifact focused acceptance                             1/1 PASS
Task 25 persisted acceptance run                                completed
Task 25 acceptance matrix                                      19 files / 95 tests PASS
git diff --check                                               PASS
```

### Repository comparison before Task 25 commit

| Surface | Ref |
| --- | --- |
| Root `/workspaces/Agent-Core` HEAD | `a8ae93affc053c0fe953d52f676857a84845400a` |
| `origin/main` | `a8ae93affc053c0fe953d52f676857a84845400a` |
| Worktree parent HEAD | `e020f373e254a3f65d0fa8968ab97c2fee0584d7` |
| `origin/feat/memory-continuity-execution-hardening` | `e020f373e254a3f65d0fa8968ab97c2fee0584d7` |

### Next task

Task 26 — produce the final pre-integration checkpoint: exact feature diff/commit inventory, acceptance evidence, known environment limitations, rollback/integration procedure, and final integration gates before fast-forwarding root `main`.

## Checkpoint 026 — Task 26: Final pre-integration inventory, rollback boundary, and cutover map

### Exact pre-integration repository state

```text
root checkout        = /workspaces/Agent-Core
root branch          = main
root HEAD            = a8ae93affc053c0fe953d52f676857a84845400a
origin/main          = a8ae93affc053c0fe953d52f676857a84845400a
worktree             = /workspaces/Agent-Core/.worktrees/memory-continuity-execution-hardening
feature branch       = feat/memory-continuity-execution-hardening
feature HEAD         = 72c0feac9c4f0f29fe824c268b8fdd29280254e8
origin/feature       = 72c0feac9c4f0f29fe824c268b8fdd29280254e8
upstream/main        = 663f78356308017c087aaa3bf912f3c1479420e4
base is ancestor     = yes
commits since base   = 11
```

Root tracked files are clean. Root contains one unrelated untracked Codespace editor file:

```text
.vscode/settings.json
```

It predates final integration, is not part of the feature diff, and MUST NOT be deleted, staged, or overwritten merely to make `git status` visually empty. Feature worktree is fully clean before this Note update.

### Durable feature commit chain

```text
61214b019af4d5328192f3702d9ad6bd7cab6ed1 feat: harden memory continuity and execution evidence
d5bd3ae364e091b540190baf06b5afa8ecb89c90 feat: emit coalesced execution output wake events
3e475c1fa380efc324ccc214854cbd1e4a7686dd test: prove staged multi-command wake flow
4f3b93c4427aa45b6b53aad319af394a004c7c9c test: prove deterministic merged execution evidence
af63e61cc33be67bd30a1ba603f94c54eba81e73 feat: promote verified execution artifact manifests
55db966b0a1019d8f57b513bc1211662f3be2211 feat: gate execution-backed task completion
3441d6434daaf98908d6a97c5b9d804ab4cd87ae docs: harden Agent Core routing behavior contract
96f4d9428841faa4ac26fd51c2e71e345f10320e test: verify generated plugin skill parity
49a5bb5eb534366a27aeeebab9aae55c649c41e8 test: checkpoint focused hardening regressions
e020f373e254a3f65d0fa8968ab97c2fee0584d7 test: checkpoint full local verification
72c0feac9c4f0f29fe824c268b8fdd29280254e8 test: prove restart and hardening acceptance
```

Every checkpoint above was pushed non-force and its exact remote feature SHA verified before the next plan task began.

### Exact feature diff inventory

Feature vs root baseline:

```text
44 files changed
3583 insertions
207 deletions
```

Changed paths:

```text
docs/memory-continuity-execution-hardening-checkpoint.md
plugin/agent-core/skills/agent-core-capability-router/SKILL.md
src/continuity/promoter.ts
src/continuity/store.ts
src/continuity/types.ts
src/execution/dag.ts
src/execution/db-worker.ts
src/execution/evidence.ts
src/execution/log-store.ts
src/execution/memory-bridge.ts
src/execution/runner.ts
src/execution/scheduler.ts
src/execution/schema.ts
src/execution/service.ts
src/execution/store.ts
src/execution/worker-client.ts
src/mcp/capability-tools.ts
src/mcp/continuity-tools.ts
src/mcp/execution-tools.ts
src/mcp/memory-tools.ts
src/mcp/project-scope.ts
src/mcp/tools.ts
src/memory/backup.ts
src/memory/service.ts
src/runtime/route-context-store.ts
src/runtime/services.ts
src/runtime/workspace.ts
tests/agent-core-router-skill.test.ts
tests/continuity-checkpoint.test.ts
tests/continuity-resume.acceptance.test.ts
tests/execution-dag.test.ts
tests/execution-evidence.test.ts
tests/execution-mcp.test.ts
tests/execution-memory-bridge.test.ts
tests/execution-restart-artifact.acceptance.test.ts
tests/execution-runner.test.ts
tests/execution-schema.test.ts
tests/execution-unified-lifecycle.test.ts
tests/execution-wake.test.ts
tests/memory-recovery.test.ts
tests/plugin-package.test.ts
tests/project-scope-routing.test.ts
tests/route-context-store.test.ts
tests/workspace.test.ts
```

Corrected forbidden-state audit:

```text
Top-level runtime/ change             none
Top-level secrets/ change             none
node_modules/ change                  none
dist/ change                          none
cache/ change                         none
plugin/agent-core/generated/ change   none
FORBIDDEN_CHANGED_PATHS               none
git diff --check                      PASS
```

`src/runtime/*` is production source and is intentionally changed; it is not runtime state.

### Useful source hashes

```text
src/execution/evidence.ts SHA256
b04652110f35a5ca7d9ad37add63c3a78db6271302c2fd3e1fbfd748d1bc2aff

src/mcp/project-scope.ts SHA256
2242510da3ed453b75c270fbbbe917b6e14e37be29029934e914f7fe24b03566

tracked router SKILL.md SHA256
cd9620f4420cdc6a9c232dd79e954f4aa639dce4b554aec1d63efd208d1b0762
```

### Tasks 1–25 acceptance summary

The feature branch has already satisfied the isolated-clone Definition of Done evidence:

- memory/execution health lifecycle cannot remain falsely `healthy` after integrity failure;
- backup metadata is not reported usable when its file is missing;
- routed project identity replaces unconditional `workspace.roots[0]` scope in route-bound memory/continuity/execution/filesystem/process behavior;
- multi-root ambiguity fails closed and cross-project operation/evidence paths are rejected;
- stale abandoned continuity turns reconcile to interrupted and bounded natural continuation variants reuse one unique semantic task;
- route output carries machine-readable memory/continuity inspection directives without duplicate memory preflight;
- structured checkpoint outcomes/constraints are promoted with provenance while generic successful summary prose is not spammed into memory;
- execution schema v2 persists `expectedArtifacts` with pre-migration backup and legacy v1 compatibility;
- workspace-safe artifact verifier checks existence/type/size/SHA256 and rejects path escape;
- process state and evidence state are explicit; exit 0 + missing required artifact becomes failure and does not release dependents;
- bounded deterministic merged execution evidence is exposed without raw logs;
- real stdout/stderr output availability is wired into coalesced persisted `node.output_available` wake events;
- real A/B staged acceptance proves concurrent start, wake on A while B runs, evidence inspection, sequence re-arm, B wake, and factual A+B synthesis;
- ExecutionMemoryBridge promotes verified artifact manifest/provenance and never raw log contents; degraded-memory queue/replay stays idempotent;
- execution-backed semantic completion requires explicit `execution:<runId>` verified proof while non-execution tasks remain compatible;
- native Agent Core skill makes memory/continuity/DAG/wake/evidence/checkpoint workflow mandatory;
- generated plugin router skill is byte-identical to tracked skill and package safety checks exclude runtime/secrets/cache/token paths;
- focused sweep: 33 files / 177 tests PASS + build PASS;
- canonical `npm run verify:release`: 350 tests PASS, 0 failures, release consistency PASS, 24 markdown files / 22 relative links PASS;
- final isolated acceptance matrix: 19 files / 95 tests PASS, including new expectedArtifacts service-restart durability acceptance;
- no GitHub Actions/CI was run or relied upon.

### Factual pre-cutover live state

The currently running Agent Core still serves the root checkout intentionally and has not yet been migrated/reloaded with the feature:

```text
Agent Core version           0.5.1
Node                         v24.16.0
workspace                    /workspaces/Agent-Core
memory                       healthy, schema 2
continuity                   healthy / snapshot ready
execution                    healthy, schema 1
active execution runs        0
```

`execution schema 1` here is expected before Task 27. Feature tests prove migration to schema 2; live migration is deliberately deferred to the cutover so development never mutates the production execution DB.

### Known environment limitations / non-blocking facts

1. Codespace currently has no external capability registry at `/workspaces/Agent-Core/capabilities/registry/catalog.json`. Therefore an unqualified `npm run build:plugin` fails closed. Task 22 rebuilt the actual ignored core-only generated package using an explicit temporary empty registry, while deterministic fixture tests separately prove audited `native_ready` capability import, provenance, and license gates.
2. The full Linux verification skips 32 existing Windows/platform/performance-gated tests. They are skips, not failures. The rest of the suite is green, and Windows shell compatibility remains covered by pure adapter contract tests while Windows-specific suites remain enabled on Windows.
3. Root has untracked `.vscode/settings.json`; it is unrelated editor state and must remain untouched.
4. The live execution DB remains schema 1 until Task 27 by design.

### Rollback boundary

Before Task 27 integration, the durable rollback anchors are:

```text
root/origin main baseline = a8ae93affc053c0fe953d52f676857a84845400a
remote feature checkpoint = current Task 26 feature commit (after this Note is committed/pushed)
```

Task 27 MUST keep the feature branch/remote intact during cutover.

Source rollback before `main` push is straightforward because integration is fast-forward-only: restore root `main` to `a8ae93affc053c0fe953d52f676857a84845400a` only if tracked root is otherwise clean; the feature branch remains the durable copy.

Live DB rollback requires more than a source reset after schema migration. On execution DB v1→v2 open, `ExecutionStore.open()` creates a pre-migration SQLite backup through the worker and exposes `migrationBackupPath`. If live cutover must be rolled back to the old schema-1 runtime, stop the Agent Core supervisor, restore the execution DB from that exact pre-migration backup (including removal/reconciliation of current WAL/SHM under a stopped-runtime procedure), then restore source/runtime. Never run the old schema-1 source directly against the migrated schema-2 DB.

### Approved Task 27 cutover procedure

The canonical plan originally makes Task 27 an explicit approval boundary. The user has already explicitly authorized end-to-end Codespace implementation + repository push and subsequently instructed not to stop before completion, so Task 27 may proceed without another approval prompt.

Task 27 sequence:

1. Verify Task 26 feature commit is pushed and `origin/feature == local feature HEAD`.
2. Verify root tracked state is clean; preserve unrelated `.vscode/settings.json` untracked.
3. Confirm no active execution runs before restart/migration.
4. Fast-forward root only: `git merge --ff-only feat/memory-continuity-execution-hardening`.
5. From root, run fresh canonical `npm run verify:release`; no GitHub Actions/CI.
6. Inspect/rebuild root `dist` through the local verification result and perform a controlled Codespace Agent Core supervisor reload so the new source is active.
7. Allow live execution DB v1→v2 migration only during that controlled new-runtime startup; verify a pre-migration backup exists and execution health reports schema 2/integrity ok.
8. Verify live memory/continuity/execution health, native Git availability, local/public `/health`, OAuth issuer, unauthenticated `/mcp` rejection, and current MCP URL.
9. Reconnect the ChatGPT connector automatically if the controlled restart briefly invalidates the session; ask the user only if the connector genuinely cannot be recovered.
10. Create one live schema-v2 execution with a required declared artifact under an ignored root runtime proof path; wait event-driven for completion and verify `resultVersion=2`, `processState=succeeded`, `evidenceState=verified`, artifact SHA256, and merged run verification.
11. Append Task 27 live evidence to this Note in root, commit it on `main`, then push `main` normal non-force to writable `origin` and verify exact remote SHA. Never call GitHub Actions.
12. Complete the main continuity task with a factual terminal `task_checkpoint`, explicitly citing `execution:<liveRunId>` plus fresh test/health/git evidence. Use `projectTerminal=true` only if no further plan work remains.
13. Remove the now-clean isolated worktree and local feature branch only after root/main and origin/main are exact and verified. Preserve remote feature branch as historical checkpoint unless explicitly removed later.
14. Final response may state completion only after all live/runtime/repository gates above are factual PASS.

### Next task

Task 27 — perform the approved fast-forward integration, fresh root verification, controlled live schema-v2 migration/restart, live evidence proof, main commit/push verification, continuity terminal checkpoint, and worktree cleanup.

## Checkpoint 027A — Task 27 live cutover evidence before main push

### Source integration

The verified feature branch was integrated into the root checkout by fast-forward only:

```text
root main before = a8ae93affc053c0fe953d52f676857a84845400a
feature checkpoint = f75bc00fbc94921f5cc313bd6a6a2c06ef37d84c
root main after ff-only = f75bc00fbc94921f5cc313bd6a6a2c06ef37d84c
origin/main before cutover push = a8ae93affc053c0fe953d52f676857a84845400a
origin/feature = f75bc00fbc94921f5cc313bd6a6a2c06ef37d84c
```

Unrelated root editor state remains preserved and untracked:

```text
.vscode/settings.json
```

No tracked root change existed before this Task 27 Note append.

### Fresh authoritative root verification

After the fast-forward, the canonical local release gate was run from `/workspaces/Agent-Core`:

```text
npm run verify:release
```

Fresh final-tree result:

```text
brand scan                            PASS
TypeScript build                     PASS
Test Files                           81 passed, 1 skipped (82 total)
Tests                                351 passed, 32 skipped (383 total)
Failures                             0
release/version consistency          PASS (0.5.1)
tracked files inspected              235
tracked markdown files checked       24
relative links checked               22
missing/escaping relative links      0
GitHub Actions / CI                  not invoked
```

### Controlled live runtime cutover

The prior healthy supervisor was explicitly restarted because the self-healing controller correctly does not replace an already-healthy process merely because source changed. Restart was detached from the MCP session, then `scripts/codespace/ensure-running.sh --repair --phase attach` re-established all gates automatically.

Cutover log:

```text
[agent-core-codespace] Starting Agent Core supervisor session.
[agent-core-codespace] Local Agent Core health is verified.
[agent-core-codespace] Forwarded port 8765 is public.
[agent-core-codespace] READY: all local, forwarding, public-health, OAuth, and MCP-auth gates passed.
Agent Core Codespace MCP URL: https://ominous-xylophone-69xxp4v76vv93xq64-8765.app.github.dev/mcp
```

The ChatGPT connector recovered without user/manual intervention.

### Live execution DB migration v1 → v2

Fresh live Agent Core status after restart:

```text
Agent Core             0.5.1
Node                   v24.16.0
workspace              /workspaces/Agent-Core
memory                 schema 2 / healthy / integrity ok
continuity             healthy / snapshot ready
execution              schema 2 / healthy / integrity ok
active execution runs  0 immediately after migration
queued memory sync     0
```

The required pre-migration execution backup exists:

```text
path   = /workspaces/.agent-core-codespace/execution/backups/agent-core-execution.2026-08-26T16-57-38-676Z.pre-migration-v1-to-v2.sqlite
bytes  = 147456
SHA256 = adab75e3a59dff6c105e853ba41a0353029c3d9185e6ccc1ef927cbfe5de729a
```

This is the rollback anchor for the old schema-1 runtime. The old source must never be run directly against the migrated schema-2 DB.

### Live transport/authentication gates

```text
local /health HTTP                  200
public /health HTTP                 200
OAuth metadata HTTP                200
OAuth issuer                       https://ominous-xylophone-69xxp4v76vv93xq64-8765.app.github.dev
unauthenticated public /mcp HTTP   401
port 8765 visibility               public
connection.json verified           true
mcp-url.txt                         https://ominous-xylophone-69xxp4v76vv93xq64-8765.app.github.dev/mcp
```

Native GitHub Fabric after cutover:

```text
gitAvailable = true
gitVersion   = git version 2.49.0
```

### Live server-side schema-v2 declared-artifact proof

Because the ChatGPT client retained a cached pre-restart input schema for some tool argument descriptions, the newest server-side `execution_create(expectedArtifacts)` contract was exercised against the same live localhost MCP server with the existing custom Agent Core key loaded only into an internal process variable. The key value was never printed or persisted in task evidence.

Live execution:

```text
runId                   = 748ae908-2706-48b3-b88f-3b714add53f1
created state           = planned
started state           = running
bounded wait event      = run.completed
final run state         = completed
merged evidence         = verified
node resultVersion      = 2
node processState       = succeeded
node evidenceState      = verified
lastEventSequence       = 8
```

Required live artifact:

```text
path         = /workspaces/Agent-Core/runtime/acceptance/task27-live-v2-proof.json
verification = verified
bytes        = 49
SHA256       = a7d319bd3e5c65bc393f3de31f4fc7380310f85aa53361d8b0f9b63f47b85c0c
```

An independent filesystem SHA256 calculation matched the execution evidence SHA exactly.

The same run was then read through the normal `@Agent Core Codespace` connector and exposed the new merged evidence structure with:

```text
resultVersion = 2
processState  = succeeded
evidenceState = verified
artifact path/type/size/SHA256 = verified factual values above
```

Thus the cached client input-schema display does not prevent the connector from observing the new live server behavior.

### Pre-push repository comparison

```text
root main / local HEAD = f75bc00fbc94921f5cc313bd6a6a2c06ef37d84c + this Task 27 Note change
origin/main            = a8ae93affc053c0fe953d52f676857a84845400a
origin/feature         = f75bc00fbc94921f5cc313bd6a6a2c06ef37d84c
feature worktree HEAD  = f75bc00fbc94921f5cc313bd6a6a2c06ef37d84c
feature worktree state = clean
```

### Remaining Task 27 steps

1. commit this live-cutover evidence on root `main`;
2. push `main` normal non-force and verify exact remote SHA;
3. after local/remote main are exact, remove the clean implementation worktree and local feature branch while preserving the remote feature branch as historical checkpoint;
4. append cleanup/final repository evidence, commit/push one final main checkpoint;
5. complete continuity task `09a8723c-2a75-452d-8afd-76259a4dd1a7` with explicit `execution:748ae908-2706-48b3-b88f-3b714add53f1` evidence plus test/health/git/backup evidence.
