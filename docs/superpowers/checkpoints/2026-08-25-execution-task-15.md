# Task 15 Checkpoint — Legacy Background Process Lifecycle Evidence

Date: 2026-08-25
Branch: `feature/local-continuity-execution-fabric`

## Gap closed

Legacy `start_process` sessions are now owner-bound and lifecycle-audited instead of remaining globally readable/stoppable inside the Agent Core runtime.

## Session ownership

`ProcessManager` stores optional durable-in-runtime session context:

- authenticated principal ID
- project ID
- origin route context ID

MCP-created sessions always receive this owner context.

Owner matching uses principal + project. The origin route is provenance only and is not required to remain active for later reads/stops.

Cross-principal/project access returns `PROCESS_SESSION_NOT_FOUND`, hiding session existence.

Direct ProcessManager callers without owner metadata remain backward-compatible for internal/unit use.

## MCP behavior

### start_process

Still requires a valid route. It now stores:

- principal
- project
- origin route ID

and installs a best-effort terminal evidence callback.

### read_process_output

Input remains only `sessionId` — no routeContextId added.

It validates the stored owner against the authenticated principal/project, then records `memory.operation_observed` using the stored origin route as provenance.

### stop_process

Input remains only `sessionId` — no routeContextId added.

It:

1. validates stored owner
2. records `memory.operation_stop_requested`
3. stops the process
4. waits for best-effort terminal audit completion
5. records `memory.operation_stop_succeeded`

Therefore direct recovery remains available even if the original route TTL has expired.

### list_processes

Returns only sessions owned by the authenticated principal in the current project.

## Terminal evidence

`ProcessManager` emits one bounded terminal snapshot:

- session ID
- PID
- cwd
- exit code/signal
- running=false
- output-truncated flag
- stdout/stderr byte counts
- start/finish timestamps

Raw stdout/stderr are not copied into terminal audit metadata.

`OperationalMemoryAudit.lifecycle()` records lifecycle events best-effort and cannot become a second operational failure path.

## TDD evidence

RED 1:

- process ownership unit test failed because `sessionContext()` did not exist.

GREEN ownership:

- `tests/process-tools.test.ts` 5/5 PASS.

RED 2:

- lifecycle MCP acceptance failed because principal B could still read a session started by principal A.

GREEN lifecycle:

- focused build PASS
- `tests/process-tools.test.ts`
- `tests/memory-operational-audit.test.ts`
- `tests/mcp-route-enforcement.test.ts`
- combined: 12/12 PASS

The existing route-enforcement recovery fixture was updated to create its direct runtime session with principal/project owner metadata. The public `stop_process` call still uses only sessionId and no route context.

Full regression:

- 62/62 test files PASS
- 242/242 tests PASS
- exit code 0
- `git diff --check` PASS before regression

## Next

Task 16: bridge factual execution events/results into DMF memory. Promote deterministic failures/artifacts/process checkpoints while keeping raw logs local; when DMF is degraded, queue idempotent promotions in `execution_memory_sync_queue` and replay them after health returns.
