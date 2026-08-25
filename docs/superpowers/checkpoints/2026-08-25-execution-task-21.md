# Task 21 Checkpoint — Agent Behavior Contract and Operator Documentation

Date: 2026-08-25
Worktree: `F:\Projects\Agent-Core\.worktrees\local-continuity-execution-fabric-admin`
Branch: `feature/local-continuity-execution-fabric-admin`
Baseline before Task 21: `74d1fe8`

## Scope

Task 21 documents the production-ready Local Continuity + Execution Fabric behavior contract and operator boundaries, while keeping live execution rollout staged for Task 22.

## Documentation Added

- `docs/local-agent-continuity.md`
  - continuity ledger purpose/scope;
  - route-to-checkpoint lifecycle;
  - deterministic snapshot/rehydration and resume rules;
  - cross-principal/project isolation;
  - terminal checkpoint + 2-5 frontier rule;
  - complete 12-step Agent Core model behavior contract;
  - platform limitation: Agent Core cannot capture messages that never invoke it and cannot send unsolicited wake messages into an inactive ChatGPT conversation.

- `docs/deterministic-execution-fabric.md`
  - execution DB/log locations and evidence format;
  - execution MCP surface and dependency/concurrency rules;
  - event journal/wake/restart recovery;
  - execution-to-DMF promotion policy;
  - raw log sensitivity and explicit statement that no automatic raw-log retention/purge policy exists yet;
  - operator backup/recovery procedure for the execution DB separately from DMF;
  - diagnostic disable procedure using `AGENT_CORE_EXECUTION_ENABLED=false`;
  - Task 20 performance evidence.

- `docs/multi-command-wake-workflow.md`
  - dependency-first decomposition;
  - `execution_create` before `execution_start`;
  - concurrent independent nodes and dynamic dependency unlock;
  - useful work while nodes run;
  - `execution_wait` only when needed;
  - persist-before-signal wake semantics;
  - explicit retry/cancel and factual log/status inspection;
  - semantic finalization through `task_checkpoint`.

- `docs/superpowers/checkpoints/local-continuity-execution-final-template.md`
  - reusable evidence template for Task 23 final stability/integration gate.

## Existing Documentation Updated

`docs/deterministic-memory.md` now records that DMF schema v2 includes the Continuity Ledger inside the same `agent-core-memory.sqlite` database and shares its isolation, backup, worker lifecycle, integrity, and recovery boundary.

## Capability Stage

`agent_core_capabilities.stage` is now:

```text
v5-local-continuity-execution-fabric
```

The enabled capability list also reports:

```text
execution.deterministic_fabric
execution.event_driven_wake
execution.evidence_bridge
```

The server remains version `0.5.0` and retains exactly 43 MCP tools. Execution's configuration default remains disabled until Task 22 staged live rollout; the v5 label identifies the production-ready contract/surface, not an implicit live feature-flag bypass.

The v5 expectation is updated in both `tests/mcp-integration.test.ts` and `scripts/smoke-test.mjs`.

## Verification

Environment:

```text
TEMP=F:\Projects\Agent-Core\runtime\test-temp
TMP=F:\Projects\Agent-Core\runtime\test-temp
```

Results:

```text
npm run build
PASS

npx vitest run \
  tests/mcp-integration.test.ts \
  tests/mcp-capabilities.test.ts \
  tests/mcp-routing.test.ts \
  tests/execution-mcp.test.ts \
  tests/continuity-checkpoint.test.ts
PASS — 5/5 files, 19/19 tests

node --check scripts/smoke-test.mjs
PASS

git diff --check
PASS
```

Static verification found v5 references in server/integration/smoke current surfaces and no remaining v4 stage references under `src`, `tests`, or `scripts`.

## Task 21 Exit Decision

**PASS.** Task 21 is complete and may advance to Task 22 Staged Rollout and Live Canary.
