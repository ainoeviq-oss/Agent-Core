# Task 14 Checkpoint — First-Class Execution MCP Tools

Date: 2026-08-25
Branch: `feature/local-continuity-execution-fabric`

## Public MCP surface

Added eight first-class execution tools:

- `execution_create`
- `execution_start`
- `execution_status`
- `execution_wait`
- `execution_logs`
- `execution_add_nodes`
- `execution_retry`
- `execution_cancel`

Total MCP tool surface is now 43 during the feature implementation. `agent_core_capabilities.stage` intentionally remains `v4-automatic-capability-routing`; the v5 stage is reserved for Task 21 after production-ready gates.

## Route and ownership model

Mutation-side tools require an active `routeContextId`:

- create
- start
- add_nodes
- retry
- cancel

The route must belong to the authenticated principal, allow the tool, satisfy required skill loads, and pass any enabled hard memory guardrail enforcement.

Read-side tools intentionally do not require the old route:

- status
- wait
- logs

They bind directly to authenticated principal + current project ownership. This permits a fresh route/chat to inspect and continue an older durable run without depending on the original route TTL, while cross-principal/project existence remains hidden as `EXECUTION_RUN_NOT_FOUND`.

## Tool behavior

### execution_create

- validates the entire DAG before persistence
- persists a planned run only
- starts zero processes
- records `run.created` + deterministic `node.queued` events
- links origin route and continuity task when available

### execution_start

Starts currently ready nodes within the persisted concurrency bound.

### execution_status

Returns compact graph/run state without exposing persistent command text:

- run state/objective/concurrency
- last event sequence
- ready/running/terminal node IDs
- bounded per-node state/dependencies/attempt count/timestamps/errors

### execution_wait

Uses the native persisted-event wake coordinator with a schema/runtime cap of 60 seconds. Timeout returns current graph state and no fabricated event.

### execution_logs

Authenticates run ownership before reading raw attempt logs. Reads stdout/stderr by stable byte offset with a maximum 1 MiB response chunk.

### execution_add_nodes

Dynamic nodes are validated against the **combined existing + proposed DAG before persistence**. Duplicate IDs, missing dependencies, cycles, node-count overflow, command safety, cwd boundaries, and inline-secret checks therefore fail before any dynamic node INSERT.

For a running graph, newly valid ready nodes are dispatched immediately. Acceptance proves dynamic C(depends A) can start after A while independent B remains running.

### execution_retry

Explicit retry only. Attempt 2 is separately persisted and attempt 1 logs/result remain intact and readable.

### execution_cancel

Supports node or whole-run cancellation. Active execution tracks both the process handle and a `settled` persistence promise so cancellation does not report completion before factual terminal attempt/node evidence has been written.

Node cancellation leaves unrelated running work active. Whole-run cancellation terminates active nodes and marks queued/ready/blocked nodes cancelled without inferring success.

## Router integration

Execution mutation tools were added to the appropriate route allowlists without removing or changing the original operational tool contract.

Existing MCP tool-count assertions were updated from 35 to 43 because the public surface legitimately gained eight execution tools.

## TDD evidence

RED:

- initial surface expected 43 tools but found 35
- after schema registration, six behavior tests failed because handlers were still deliberate stubs

GREEN focused:

- TypeScript build PASS
- execution MCP + scheduler + wake suites: 17/17 PASS
- broader MCP/router/continuity regression: 29/29 PASS

Full regression:

- 62/62 test files PASS
- 240/240 tests PASS
- exit code 0
- `git diff --check` PASS before full regression

## Live safety

- execution remains disabled by default in production configuration
- no live execution DB was opened by rollout
- stage remains v4
- existing custom Agent Core key/OAuth behavior unchanged

## Next

Task 15: close the legacy background process lifecycle evidence gap by binding process sessions to principal/project/origin route and auditing read/stop/terminal evidence without requiring an expired original route.
