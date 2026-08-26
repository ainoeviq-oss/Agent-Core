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
