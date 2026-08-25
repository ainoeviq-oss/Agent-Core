# Local Agent Continuity

Local Agent Continuity is the project/task-state layer built on top of Agent Core's Deterministic Memory Fabric (DMF). It exists so a later Agent Core route can recover the factual state of ongoing work instead of asking the user to reconstruct progress from memory.

Continuity is not a second memory server. Its ledger tables live inside the same DMF SQLite database and use the same authenticated principal/project scope, SQLite worker lifecycle, backup boundary, and fail-closed health model.

## What continuity stores

The Continuity Ledger stores observable project state rather than private chain-of-thought:

- routed turns and their state: `open`, `closed`, or `interrupted`;
- tasks, objectives, acceptance criteria, constraints, parent relationships, priority, blockers, and status;
- explicit task dependencies;
- structured checkpoints with evidence and deterministic state hashes;
- deferred work and a bounded next-work frontier;
- execution continuity summaries such as active/interrupted run IDs and the last execution checkpoint.

Task status is explicit. A process exit is evidence about a process; it is **not** sufficient to mark the semantic task completed. Task completion happens through `task_checkpoint`.

## Route-to-checkpoint lifecycle

```text
user request
   |
   v
capability_route
   |
   +--> authenticated principal/project scope
   +--> DMF recall
   +--> bounded continuity snapshot
   |
   v
current objective + active/deferred/blocked work + frontier
   |
   v
agent performs verified work
   |
   v
task_checkpoint
   |
   +--> summary
   +--> evidence
   +--> decisions/artifacts
   +--> blockers/deferred work
   +--> 2-5 next candidates (unless projectTerminal=true)
   |
   v
next route/session can rehydrate the state
```

`capability_route` begins or resumes a continuity turn when continuity storage is healthy. The route context carries continuity task/turn/snapshot identity. If continuity persistence is degraded, capability routing remains available and reports degraded continuity rather than inventing state.

## Deterministic rehydration

A continuity snapshot is bounded and deterministically ordered. It prioritizes current work over old chatter and returns categories such as:

- active tasks;
- recently completed tasks;
- blocked tasks;
- deferred tasks;
- unfinished plans;
- frontier candidates;
- interrupted turns;
- active and interrupted execution runs when execution is enabled;
- last execution checkpoint.

For unchanged persisted state, the returned bounded snapshot and snapshot hash are deterministic. Older unrelated semantic memory cannot displace the bounded current task/frontier state merely because it is newer chatter.

## Resume semantics

A fresh authenticated route can resume verified unfinished work. When exactly one resumable active/interrupted task exists and the request is a known continuation phrase, Agent Core may deterministically link the new turn to that task. If multiple candidates make the continuation ambiguous, it returns candidates instead of guessing.

Continuity isolation follows the DMF scope:

- one principal cannot read another principal's task state;
- one project cannot read another project's task state;
- execution runs exposed through continuity are scoped the same way.

## Terminal checkpoint rule

A terminal task checkpoint requires 2-5 next candidates unless `projectTerminal=true`. This preserves an actionable frontier rather than leaving future sessions with only a dead-end historical summary.

The candidates are not autonomous instructions to execute blindly. They are structured possible next work for the next routed agent to evaluate against the user's request and current evidence.

## Agent behavior contract

Any model using Agent Core for actionable work should follow this contract:

1. Begin actionable work with `capability_route`.
2. Read the returned continuity snapshot before deciding where to start.
3. Reuse/resume a verified active task when appropriate instead of creating duplicate work.
4. If work contains two or more independent command nodes, prefer the execution DAG rather than manually serializing everything.
5. Declare dependencies explicitly; never parallelize state-dependent commands blindly.
6. Start ready independent nodes concurrently within the configured bound.
7. Do useful independent work while execution runs are active.
8. Call `execution_wait` only when no useful ready work remains.
9. On wake/return, inspect factual status and logs before deciding what happened.
10. Retry explicitly; never assume failure or success.
11. Finalize a terminal semantic task with `task_checkpoint`, evidence, and 2-5 next candidates unless the project is terminal.
12. In a later session, use persisted continuity state instead of asking the user to reconstruct progress when verified state already exists.

## Failure model

Continuity is deliberately fail-closed:

- DMF degradation does not erase execution state;
- execution degradation does not make OAuth/MCP unavailable;
- an unfinished turn is surfaced as open/interrupted work, never silently completed;
- restart recovery never infers task success from a missing PID or missing process;
- raw stdout/stderr is not copied wholesale into DMF continuity state.

## Platform boundary

Agent Core is invoked through the connected MCP/app path. It cannot see a ChatGPT message that never invokes Agent Core, so local continuity cannot capture turns it never receives.

The execution wake system can wake an in-process `execution_wait` call from a persisted local event. It **cannot send an unsolicited message into an inactive ChatGPT conversation**. A later user/session invocation can rehydrate the persisted run/task state and continue from there.

## Related documentation

- `docs/deterministic-memory.md` — DMF storage, health, backup, recovery, and deterministic recall.
- `docs/deterministic-execution-fabric.md` — durable execution database, logs, recovery, security, and operator procedures.
- `docs/multi-command-wake-workflow.md` — dependency-aware concurrent execution and event-driven wake behavior.
