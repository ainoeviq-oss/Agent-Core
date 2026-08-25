# Deterministic Execution Fabric

The Deterministic Execution Fabric is Agent Core's local, durable, dependency-aware command execution layer. It persists run/node/attempt/event state in a separate SQLite database from DMF and writes raw process evidence to local files under the Agent Core root.

It is designed to make concurrency, dependencies, retries, wake behavior, restart recovery, and evidence factual. The model supplies semantic decomposition and decisions; Agent Core enforces the declared graph and records what actually happened.

## Rollout state

The execution fabric is production-gated by Tasks 19-21, but its configuration default remains disabled until the staged live rollout in Task 22.

```text
AGENT_CORE_EXECUTION_ENABLED=false   # current pre-rollout default
```

The v5 capability stage means the execution surface and behavior contract are production-ready; it does not bypass the staged live enablement/canary procedure.

## Runtime locations

Default execution database:

```text
<Agent-Core-root>\runtime\execution\agent-core-execution.sqlite
```

Default raw evidence root:

```text
<Agent-Core-root>\runtime\execution\runs\
```

Per-attempt evidence layout:

```text
runtime\execution\runs\<runId>\<nodeId>\attempt-001.stdout.log
runtime\execution\runs\<runId>\<nodeId>\attempt-001.stderr.log
runtime\execution\runs\<runId>\<nodeId>\attempt-001.result.json
```

The terminal result marker is written atomically and records factual run/node/attempt identity, timestamps, state, exit code/signal, byte counts, and SHA-256 hashes of stdout/stderr.

## Persistence model

The execution SQLite database contains durable records for:

- execution runs;
- nodes;
- hard dependencies;
- attempts;
- monotonic per-run events;
- execution-to-DMF sync queue entries;
- schema migration state.

The execution database is intentionally separate from the DMF database because execution events/log metadata are high-frequency operational state. Only selected verified execution evidence is promoted into DMF.

## MCP execution surface

Agent Core exposes:

```text
execution_create
execution_start
execution_status
execution_wait
execution_logs
execution_add_nodes
execution_retry
execution_cancel
```

Mutation tools require a current principal-bound route context. Read operations are authenticated and principal/project scoped, so a fresh same-principal route can inspect an older owned run without requiring the original route to remain alive.

`execution_create` persists a validated DAG but starts no process. `execution_start` dispatches ready nodes up to the run's concurrency bound. Dynamic nodes can be added atomically while a run is planned/running; invalid cycles or missing dependencies are rejected without partial insertion.

## Dependency and concurrency rules

Default bounds:

```text
maxConcurrency = 4
maxNodes       = 128
waitMaxMs      = 60000
```

The scheduler applies these rules:

- independent ready nodes can run concurrently;
- a node becomes ready only after all hard dependencies succeeded;
- a dependent of a failed/interrupted/cancelled hard dependency becomes blocked;
- unrelated work continues after another node fails;
- max concurrency is never exceeded;
- scheduling order uses deterministic node-ID tie-breaking;
- retries are explicit and create a new attempt while preserving prior evidence.

A process completion never completes the semantic continuity task. It updates execution truth; the agent still finalizes the task with `task_checkpoint` after inspecting evidence.

## Event journal and wake

Every run has a persisted monotonic event sequence. Events include run creation/start/terminal states and node queued/ready/started/output/terminal/retry/cancel states.

Persist-before-signal is the invariant: the event is committed to SQLite before the in-process wake coordinator emits its signal. `execution_wait` first checks for an unseen persisted event, subscribes, performs one bounded race-closing read, and then waits for either a persisted signal or timeout. It does not busy-poll the database.

Rapid output notifications are coalesced so arbitrary stdout chunk rates cannot create an event storm.

See `docs/multi-command-wake-workflow.md` for the agent-facing workflow.

## Restart recovery

On execution service startup, persisted attempts that still say `running` are reconciled against durable result markers:

- if a valid terminal result marker exists, the marker is factual authority;
- if no terminal result marker exists, the attempt/node becomes `interrupted`;
- missing PID/process state is never treated as success;
- interrupted work can be retried explicitly and prior logs remain intact.

On graceful Agent Core shutdown, new runs stop being accepted, active owned nodes are terminated/recorded as interrupted unless terminal evidence already exists, and the execution SQLite worker is checkpointed before close.

Execution degradation is reported separately. A corrupt/degraded execution DB does not make Agent Core OAuth/MCP unavailable and does not erase DMF continuity memory.

## Execution-to-DMF bridge

Promotion policy is deliberately narrow:

```text
raw stdout/stderr       -> execution logs only
command progress        -> execution event journal
failure signature       -> redacted DMF failure evidence
verified artifact/hash  -> DMF/checkpoint evidence
run terminal state      -> process checkpoint
semantic task completed -> task_checkpoint only
```

If DMF is degraded, eligible promotions enter `execution_memory_sync_queue`. They are replayed idempotently after memory returns healthy. Raw process logs are never promoted wholesale.

## Raw log sensitivity

Raw execution stdout/stderr is authenticated local evidence, not sanitized memory. If a command intentionally prints a secret, that plaintext may exist in its raw log file. Therefore:

- treat `runtime\execution\runs\` as sensitive operator data;
- do not publish, attach, or commit raw logs without reviewing them;
- use bounded `execution_logs` reads instead of dumping entire files into prompts;
- keep secrets in environment/file references rather than inline command text where possible;
- DMF search/export must remain free of plaintext secrets from raw logs.

There is currently **no automatic raw-log retention/purge policy** in the execution fabric. Retention is operator-managed. Delete old run evidence only when it is no longer needed for audit/recovery and after preserving any required backup/evidence.

## Operator backup

The execution database does not currently expose a model-facing backup/restore tool like DMF. Back it up as an operator action while Agent Core is cleanly stopped.

Recommended procedure:

1. Exit Agent Core through the verified tray path so execution processes are reconciled and SQLite WAL is checkpointed.
2. Confirm no Agent Core execution worker remains active.
3. Copy `runtime\execution\agent-core-execution.sqlite` to an operator-controlled backup path on F:.
4. If recovery/audit of command output matters, copy the corresponding `runtime\execution\runs\` directory with the database backup.
5. Validate the copied SQLite file with `PRAGMA quick_check` before relying on it.

Example validation from the Agent Core root:

```powershell
$env:EXECUTION_BACKUP_PATH = 'F:\path\to\agent-core-execution.backup.sqlite'
@'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.EXECUTION_BACKUP_PATH, { readOnly: true });
try {
  console.log(db.prepare('PRAGMA quick_check').all());
} finally {
  db.close();
}
'@ | node --input-type=module
```

Do not copy over a live execution database while Agent Core is running.

## Operator recovery / restore

For an execution DB backup restore:

1. Cleanly stop Agent Core.
2. Preserve the current execution DB and any required run logs before replacement.
3. Validate the selected backup with `PRAGMA quick_check`.
4. Replace the stopped execution database with the validated backup.
5. Restore matching run-evidence directories when they are part of the recovery set.
6. Start Agent Core.
7. Verify `agent_core_status` / `/health` reports execution healthy with integrity `ok`.
8. Inspect interrupted/active runs; let normal startup recovery reconcile any persisted running attempts using terminal result markers.

A restored DB without matching raw log/result files may leave evidence incomplete. Agent Core must not fabricate terminal success in that condition.

## Disable execution for diagnostics

Execution can be disabled without deleting its database or logs. Stop Agent Core, then start a diagnostic process with:

```powershell
$env:AGENT_CORE_EXECUTION_ENABLED = 'false'
node dist\index.js
```

DMF, continuity, authentication, routing, and legacy operational tools can remain available. Execution health reports disabled.

To remove the temporary override:

```powershell
Remove-Item Env:AGENT_CORE_EXECUTION_ENABLED -ErrorAction SilentlyContinue
```

Then start through the normal launcher/configuration. Task 22 controls when normal live operation changes the execution feature flag.

## Performance gates

Task 20 measured the production-ready execution path in isolated benchmark runs:

```text
128-node DAG validation p95   2.742 ms   (< 50 ms)
ready dispatch p95           34.035 ms  (< 100 ms)
wake delivery p95             7.323 ms  (< 250 ms)
max observed concurrency      4 / 4
```

These numbers are evidence for the validated Task 20 worktree and are not a promise that every host/storage configuration will produce identical timings.
