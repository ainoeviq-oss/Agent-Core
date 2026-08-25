# Task 20 Checkpoint — Performance, Security, Isolation, and Determinism Gates

Date: 2026-08-25
Worktree: `F:\Projects\Agent-Core\.worktrees\local-continuity-execution-fabric-admin`
Branch: `feature/local-continuity-execution-fabric-admin`
Baseline before Task 20: `44d780a`

## Scope

Task 20 closes the performance/security/isolation/determinism gates for the Local Continuity + Execution Fabric without weakening runtime safety boundaries. Wall-clock performance assertions are run as isolated benchmark gates so unrelated I/O-heavy suites cannot contaminate p95 measurements; normal `npm test` retains the functional/determinism/security assertions.

## Production Change

`src/execution/dag.ts` now caches identical `WorkspacePolicy.resolveExisting(cwd)` resolutions within a single DAG validation. The security boundary is unchanged: every distinct CWD is still workspace-policy checked and realpath-resolved. The optimization only removes duplicate realpath syscalls when many nodes use the same CWD.

## Performance Gate Evidence

### Deterministic execution benchmark

Command:

```text
npm run benchmark:execution -- --samples=20 --warmup=3
```

Authoritative isolated result:

```text
DAG validation @128 nodes p95      2.742 ms   target < 50 ms   PASS
Ready-node dispatch p95           34.035 ms  target < 100 ms  PASS
Wake delivery p95                  7.323 ms  target < 250 ms  PASS
Max observed concurrency           4         configured 4     PASS
Max event queries per wait         2         bounded          PASS
```

The dedicated `AGENT_CORE_PERFORMANCE_GATES=1` Vitest run also passed all 6 Task 20 tests.

### DMF 100k benchmark

Command:

```text
npm run benchmark:memory -- --count=100000 --samples=25 --warmup=5 --target-p95-ms=150
```

Authoritative result:

```text
Active memory items             100001
FTS rows                        100001
SQLite integrity               ok
DMF preflight/recall p95       69.13 ms   target < 150 ms   PASS
FTS candidate p95              24.914 ms
Graph expansion p95            51.025 ms
PPR p95                        10.279 ms
```

The benchmark fixture seeder was changed to a deterministic set-based SQLite fixture path so 100k benchmark setup does not spend most of its time on synthetic JS→SQLite provenance calls. Production `MemoryStore.commitMemory()` remains unchanged and is still invoked once after the 100k fixture is built to test a real production write at scale.

## Determinism / Scheduler Gates

`tests/execution-performance.test.ts` proves:

- repeated 10k continuity snapshots preserve identical ordering/hash when persisted state is unchanged;
- 128-node DAG validation ordering is deterministic;
- max concurrency is never exceeded;
- concurrent terminal events are serialized and a newly unlocked dependent is dispatched exactly once;
- persisted wake behavior uses bounded query count and no busy polling loop;
- raw execution log reads remain bounded and principal/project scoped.

Existing `tests/execution-wake.test.ts` continues to prove rapid `node.output_available` notifications are coalesced rather than creating an event storm.

## Security / Isolation Gates

- Cross-principal and cross-project execution visibility/mutation denial remains green through execution store/MCP/performance coverage.
- Raw log access is owner-scoped and hard-bounded to the configured byte limit.
- Synthetic secret bridge acceptance confirms the secret may exist in authenticated raw execution stderr when intentionally emitted, but does not appear in DMF search/export.
- The secret gate additionally byte-scans the DMF SQLite database and sidecars (`.sqlite`, `-wal`, `-shm` when present) for the synthetic sentinel; zero plaintext matches are required and PASS.
- OAuth/custom Agent Core key behavior is unchanged.

## Full Regression After Task 20 Changes

Environment:

```text
TEMP=F:\Projects\Agent-Core\runtime\test-temp
TMP=F:\Projects\Agent-Core\runtime\test-temp
```

Results:

```text
npm run build
PASS — TypeScript exit code 0

npm test
PASS — 68/68 test files
PASS — 266 tests
SKIP — 4 isolated wall-clock performance tests (270 total)
Duration — 153.64 s

git diff --check
PASS
```

The four skipped tests are not waived gates: they are executed separately with `AGENT_CORE_PERFORMANCE_GATES=1` and have passed. This prevents whole-suite disk/CPU contention from turning benchmark thresholds into flaky functional tests.

## Task 20 Exit Decision

**PASS.** Task 20 is complete and may advance to Task 21 Agent Behavior Contract, Capabilities, and Operator Documentation.
