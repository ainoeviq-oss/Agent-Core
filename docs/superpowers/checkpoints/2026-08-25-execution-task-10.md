# Task 10 Checkpoint — Deterministic Execution DAG

Date: 2026-08-25
Branch: `feature/local-continuity-execution-fabric`

## Implemented

`src/execution/dag.ts` now validates and normalizes dependency-aware command graphs before persistence/execution.

Safety/shape gates:

- duplicate node IDs rejected
- malformed IDs/text/timeouts rejected
- graph max-node bound enforced (default target 128)
- missing dependencies rejected
- cycles rejected
- CWD must exist inside the WorkspacePolicy realpath boundary
- existing `assertCommandAllowed` is reused for blocked commands
- obvious literal credential assignments/Bearer values are rejected from persistent command text
- environment references such as `$env:API_KEY` and file references remain allowed

Determinism:

- dependency IDs are de-duplicated and sorted
- Kahn topological ordering uses node ID as deterministic final tie-break
- returned nodes follow the same stable topological order
- `readyNodes()` returns only queued/ready nodes whose hard dependencies are all `succeeded`

Dependency semantics proven:

- A and B with no dependencies are ready simultaneously
- C(depends A) becomes ready as soon as A succeeds even while B is running
- D(depends A+B) does not become ready until both A and B succeed
- A failure does not prevent unrelated B from being ready, but A-dependent C/D remain locked

## TDD evidence

RED:

- module surface failed because `src/execution/dag.ts` did not exist
- after the minimal surface stub, 6/6 behavior tests failed against `EXECUTION_DAG_NOT_IMPLEMENTED`

GREEN:

- focused DAG suite: 6/6 PASS
- `npm run build`: PASS
- full regression: 58/58 test files PASS, 218/218 tests PASS, exit code 0
- `git diff --check`: PASS before full regression

## Live safety

No execution DAG has been enabled in the live Agent Core service. This remains feature-worktree-only pending later MCP, recovery, health, and staged rollout tasks.

## Next

Task 11: durable local per-attempt stdout/stderr logs, byte-offset bounded reads, SHA-256 evidence, and an atomic terminal result marker where absence can never mean success.
