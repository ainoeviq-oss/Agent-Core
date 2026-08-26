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
