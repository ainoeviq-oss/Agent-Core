# Multi-Command + Wake Workflow

This document describes how an Agent Core-using model should turn a task into dependency-aware concurrent work without losing factual ordering, evidence, or continuity.

The central rule is simple: **parallelize independence, serialize dependency, and let persisted evidence decide reality.**

## Entry point

Actionable work begins with `capability_route`. The route establishes authenticated principal/project identity and returns relevant DMF/continuity state. Before creating new work, inspect that state for an existing active/interrupted task that should be resumed.

When execution is enabled and the task contains two or more independent command nodes, prefer the deterministic execution fabric instead of manually launching unrelated commands one after another.

## Decompose by dependency, not by convenience

Example:

```text
A  independent build/check
B  independent scan/check
C  depends only on A
D  depends on A + B
```

Declare:

```text
A: dependsOn=[]
B: dependsOn=[]
C: dependsOn=[A]
D: dependsOn=[A,B]
```

Do not add fake dependencies merely to force serial execution. Do not omit a real dependency merely to gain concurrency.

## Create before starting

Use `execution_create` to validate and persist the entire planned graph. Creation performs validation but does not start a process.

Validation rejects, among other invalid graphs:

- duplicate node IDs;
- missing dependencies;
- dependency cycles;
- more than the configured maximum nodes;
- CWD paths outside workspace roots or escaping through real paths;
- blocked/high-risk command forms;
- obvious inline secret material that should instead use environment/file references.

Only after graph creation succeeds should the agent call `execution_start`.

## Concurrent scheduling

At run start, ready independent nodes launch up to `maxConcurrency` (default 4). Deterministic node-ID ordering is used as the final tie-break.

For the A/B/C/D graph:

```text
T0: A starts
T0: B starts

A succeeds while B still runs
   |
   +--> C becomes ready and may start immediately
   +--> D remains blocked on B

B succeeds
   |
   +--> D becomes ready
```

This means a long B node does not artificially hold C when C only depends on A.

## Useful work while commands run

Do not turn `execution_wait` into an automatic next step immediately after `execution_start`.

While A/B are running, the agent should continue any useful work that does not depend on their results, for example:

- inspect already-available code or docs;
- prepare a later patch that does not depend on command output;
- analyze persisted status/evidence from prior nodes;
- write documentation for an independent completed unit;
- verify other already-terminal branches.

Only call `execution_wait` when no useful ready work remains or when a specific terminal event/result is required to continue.

## Event-driven wait

`execution_wait` waits for a persisted event after a known sequence number. The runtime uses a persist-before-signal invariant and a bounded race-closing read; it does not busy-poll SQLite.

Typical pattern:

```text
status = execution_status(runId)
afterSequence = status.lastEventSequence

execution_wait(
  runId,
  afterSequence,
  eventTypes=[node.succeeded,node.failed,node.interrupted],
  timeoutMs<=60000
)
```

A timeout means only that no matching unseen event arrived in the bounded wait. It does not imply failure or success. Inspect the returned graph state.

## Wake semantics

A persisted event can wake an active in-process `execution_wait` call. For example, A can finish and wake the waiting agent while B remains `running`, allowing C to be started/unlocked without waiting for B.

The wake system is local process coordination. It does **not** create unsolicited assistant messages in an inactive ChatGPT conversation. If the chat/session is no longer active, the run remains durable; the next authenticated invocation can inspect/continue it through continuity and execution status.

## Inspect before deciding

After a wake or terminal event:

1. inspect `execution_status`;
2. read the relevant bounded `execution_logs` range when needed;
3. use result/event state as factual authority;
4. decide whether to continue, add nodes, retry, block, or finalize.

Never infer command success because a process disappeared, because a PID is absent, or because time passed.

## Dynamic follow-up nodes

Sometimes C cannot be known until A returns evidence. Use `execution_add_nodes` while the run is planned/running.

Example:

```text
A -> generates artifact path/hash
B -> unrelated slow test still running

agent inspects A evidence
agent adds C(dependsOn=A)
C can start while B is still running
```

The combined graph is revalidated atomically. A cyclic/missing-dependency dynamic batch is rejected without partial inserts.

## Failure isolation

If A fails while B is independent:

```text
A = failed
B = keeps running
C(depends A) = blocked
D(depends A+B) = blocked
```

Unrelated work is not cancelled automatically.

A retry is explicit:

```text
execution_retry(runId, nodeId=A)
```

Attempt 2 is created while attempt 1 logs/result evidence remain preserved. No destructive automatic retry is performed.

## Cancellation

`execution_cancel` can cancel one owned running node or the whole owned run. Cancellation is factual state, not success. Dependents are reconciled according to dependency state.

## Raw logs vs continuity memory

Raw stdout/stderr remains in execution evidence files and may contain sensitive data. Read only the bounded portion needed for a decision.

The execution-to-DMF bridge promotes only structured/redacted evidence such as failure signatures, verified artifacts/hashes, and process checkpoints. A successful process does not automatically become a completed semantic task.

## Semantic finalization

After the agent has inspected the factual result and acceptance criteria, finalize the semantic task through `task_checkpoint`.

Terminal checkpoint should include:

- concise result summary;
- test/file/log/hash/health evidence references;
- explicit decisions/artifacts where relevant;
- blockers/deferred items;
- 2-5 next candidates unless `projectTerminal=true`.

This is what allows the next session to start from a verified frontier instead of reconstructing history.

## Recommended end-to-end pattern

```text
USER TASK
  |
  v
capability_route
  |
  +--> inspect continuity snapshot
  v
resume/create semantic task
  |
  v
decompose dependency graph
  |
  v
execution_create
  |
  v
execution_start
  |
  +--> A running
  +--> B running
  |
  +--> do other useful independent work
  |
  v
execution_wait (only when needed)
  |
  v
persisted event wakes wait
  |
  +--> execution_status
  +--> bounded execution_logs
  |
  +--> add dynamic nodes if needed
  +--> explicit retry if justified
  |
  v
verify acceptance criteria
  |
  v
task_checkpoint
  |
  v
next session rehydrates task + frontier + active/interrupted runs
```

## Performance evidence from Task 20

On the validated Task 20 worktree:

```text
128-node DAG validation p95   2.742 ms
ready dispatch p95           34.035 ms
wake delivery p95             7.323 ms
```

These measurements demonstrate the gate on the validated environment; execution correctness remains governed by persisted state and tests rather than by timing assumptions.
