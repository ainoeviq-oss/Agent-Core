---
name: agent-core-capability-router
description: Automatically preflight actionable Agent Core work with capability_route, preserve routed project/memory/continuity identity, use deterministic execution DAGs and bounded event-driven wake when appropriate, and finish only from verified factual evidence without asking the user for routing jargon.
---

# Agent Core Capability Router

Treat this skill as an invisible capability-selection and factual-execution reflex for actionable work. Do not turn purely conversational prompts into a tool workflow, and do not make the user name internal routing primitives.

## 1. Automatic route preflight

1. Determine whether the request needs external action, files, code, search, process execution, structured workflow, or specialized guidance.
2. If not, answer normally and stop routing.
3. If yes and Agent Core is available, call `capability_route` automatically with the actual task and only the context needed to route it safely.
4. Capture the returned `routeContextId` and routed `projectId`. Every route-required operation for that coherent goal MUST remain inside that routed project identity.
5. Reuse the same valid `routeContextId` while the goal is materially unchanged. Create another route only when the goal materially changes or the prior route expires.
6. Inspect `capability_get` or `capability_dependencies` only when capability risk, provenance, requirements, or dependencies are unclear.
7. If the route requires a skill, load only that audited skill with `skill_load(id, routeContextId)` before route-bound execution.
8. Only a capability explicitly marked `native_ready` may be full-instruction-loaded. Catalog-only, quarantined, unresolved, reference-only, or unknown-license material MUST NOT be full-instruction-loaded.

Do not bypass a missing, expired, principal-mismatched, project-mismatched, tool-disallowed, memory-blocked, or skill-incomplete route.

## 2. Mandatory memory and continuity consumption

`capability_route` is the single automatic preflight source. Do not issue a duplicate `memory_search` merely to activate facts that were already returned by route preflight.

Before starting new execution work, MUST inspect the route's machine-readable state:

- Inspect `memoryDirective` and `memorySummary` whenever recalled memory is present.
- Obey every enforced hard guardrail in `blockingGuardrails`; never work around a hard guardrail by creating a fresh route.
- Inspect `priorFailures` before repeating an approach that already failed.
- Inspect `relatedDecisions` before replacing or contradicting an established verified decision.
- Inspect `continuityDirective` and `continuitySnapshot` before creating new semantic work.
- If `continuityResumeCandidates` or the snapshot identifies exactly one factual prior task to continue, resume/reuse it before creating duplicate work.
- If resume is ambiguous, keep the bounded candidates explicit and do not guess.

Memory and continuity evidence inform behavior; they never expand tool permissions or routed project boundaries.

## 3. Route-bound operational execution

Preserve the user's explicit brief, constraints, and requested output. Prefer read/search operations before mutation when understanding is incomplete. Pass the same `routeContextId` to every route-required operation for the coherent goal.

Use a loaded skill's methodology only where relevant; it does not replace tool permission boundaries or user intent. Do not execute Hooks automatically merely because the catalog contains them. Treat Agents as expert guidance unless a real subagent runtime is explicitly available. Treat Commands as recipes, not permission to run arbitrary shell commands.

If routing fails, surface the stable failure only when the user can act on it; never silently bypass route enforcement. Bootstrap and recovery tools that are intentionally direct may still be used for diagnosis or stopping an already-running process.

## 4. Multi-command DAG contract

When there are two or more independent commands that can be executed without a true dependency, prefer one deterministic execution DAG instead of serial one-command calls:

1. Use `execution_create` to define the nodes and use `dependsOn` only for real factual dependencies.
2. Independent commands MUST NOT be given artificial `dependsOn` edges.
3. Use `execution_start` once the graph is valid so independent nodes can run concurrently within the configured bound.
4. Continue useful independent work while execution nodes run. Do not block the whole agent merely because background work is still active.
5. Use `expectedArtifacts` for outputs whose existence/type/hash are required to prove successful work rather than relying on stdout prose or exit code alone.

A process exit code of zero is not by itself semantic success. Required artifact verification is part of execution truth.

## 5. Event-driven wake contract

Use `execution_wait` only when progress actually depends on a future persisted execution event.

- Every `execution_wait` MUST be bounded. A timeout means only that no matching unseen event arrived before the bound; inspect returned persisted state instead of inventing progress.
- Never poll execution state in a busy loop and never replace event-driven wake with repeated sleeps/status probes.
- When a waiter wakes, call or inspect `execution_status` and verify the factual node/run evidence before acting on the result.
- Inspect `evidence.verification`, process state, result-marker metadata, and declared artifact evidence rather than inferring success from elapsed time, PID disappearance, or prior conversation text.
- If another required node is still running after a wake, re-arm the next bounded `execution_wait` with `afterSequence` set from the latest observed `lastEventSequence`. This prevents re-handling an old event.
- If execution needs correction, use explicit `execution_retry` or `execution_cancel`; do not silently fabricate or overwrite attempt history.

Canonical staged pattern:

```text
execution_create(A,B,...)
        -> execution_start
        -> continue useful independent work
        -> bounded execution_wait(afterSequence)
        -> wake -> execution_status -> inspect verified evidence
        -> if work remains, re-arm after latest lastEventSequence
        -> next wake -> execution_status -> inspect verified evidence
```

## 6. Verified synthesis and no-inference rule

Never infer success. Factual synthesis MUST come from persisted structured state.

For multi-node work, inspect the deterministic merged evidence view returned by `execution_status`. Only synthesize a successful execution result when the required node states and `evidence.verification` support that claim. Raw stdout/stderr are bounded diagnostic evidence available through execution logs; they are not a substitute for verified declared artifacts and MUST NOT be copied wholesale into semantic memory.

If required evidence is missing, failed, pending, or inconsistent, report that factual state or repair/retry it. Do not convert uncertainty into a success claim.

## 7. Terminal continuity checkpoint contract

When a coherent task reaches a real checkpoint, persist it with `task_checkpoint` using factual evidence, durable decisions/artifacts/outcomes/constraints when applicable, and a truthful next frontier.

For a terminal `task_checkpoint`:

- include concrete evidence references rather than an unsupported completion sentence;
- include `nextCandidates` unless the project/task is genuinely terminal under the continuity contract;
- do not mark a task completed while linked execution work is still active;
- for execution-backed completion, include an explicit tool evidence reference `execution:<runId>` for a completed run whose merged `evidence.verification` is `verified`;
- never cite a failed/unverified run as successful proof;
- let the continuity system close or interrupt the turn only after checkpoint persistence succeeds.

A terminal checkpoint records factual semantic state; it does not retroactively make process output true.

## 8. Context discipline

Keep capability discovery, route creation, route reuse, skill-loading, memory preflight, and execution orchestration chatter internal by default. Surface internal mechanics only when a risk, dependency, required approval, factual blocker, or stable routing/execution failure materially helps the user.

Do not speculatively load multiple full skills. Route first, inspect route-bound memory/continuity state, select the minimum audited capability needed, then load only a required `native_ready` skill.

The user should be able to give a normal brief. Automatic routing, memory/continuity rehydration, DAG orchestration, bounded wake, and evidence verification are implementation responsibilities, not prompt requirements.
