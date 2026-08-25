# Local Continuity + Execution Final Stability Checkpoint Template

Use this template for the final evidence-bearing stability gate. Replace placeholders with factual outputs; do not mark a gate PASS without evidence.

## Identity

```text
Date:
Validated branch:
Validated HEAD:
Integration target branch:
Safety branch:
Agent Core server version:
Capability stage:
```

## Source / Working Tree

```text
git status:
git diff --check:
expected changed files only:
unrelated user files preserved:
clean validation checkout/worktree:
```

## Authentication / Credentials

Record hashes/metadata only. Never paste credential contents.

```text
custom Agent Core key file hash before:
custom Agent Core key file hash after:
OAuth/key-store relevant hashes before:
OAuth/key-store relevant hashes after:
authentication smoke result:
```

## DMF

```text
enabled:
healthy:
integrity:
schema version:
database path:
backup created before live migration/deploy:
backup integrity:
100k recall p95:
secret audit DB/WAL/SHM/export/search:
```

## Continuity

```text
snapshot ready:
deterministic repeated snapshot/hash:
cross-principal isolation:
cross-project isolation:
deferred/frontier rehydration:
interrupted/open turn recovery:
cross-session resume:
```

## Execution Fabric

```text
enabled/live rollout stage:
healthy:
integrity:
schema version:
database path:
log root:
DAG 128-node validation p95:
ready dispatch p95:
wake delivery p95:
max concurrency observed/configured:
output coalescing:
duplicate dispatch race gate:
raw log scope/bounds:
execution-to-DMF secret promotion audit:
```

## Restart / Rehydration

```text
active process/run before restart:
terminal marker case after restart:
missing-marker case after restart:
false-success observed (must be NO):
continuity state after restart:
```

## Build / Tests

```text
clean install result:
build result:
full test files:
full tests:
performance gate tests:
Task 19 user workflow A-J:
stress repetitions:
restart/recovery acceptance:
```

## Live Canary

```text
Agent Core PID:
port owner:
tunnel readiness:
/health:
agent_core_status:
continuity status:
execution status:
live A/B/C dependency canary:
cross-route continuation:
```

## Integration / Remote

```text
integration method:
no reset --hard / destructive cleanup:
post-integration HEAD:
post-integration full health/canary:
remote target:
push commit/range:
push result:
```

## Final Decision

Declare **STABLE** only when all required gates above are evidence-backed PASS:

```text
OAuth/MCP              healthy
DMF                    healthy, integrity ok
Continuity Ledger      healthy, deterministic snapshot
Execution Fabric       healthy, integrity ok
Parallel DAG           dependency-correct
Wake                   event-driven, bounded, no busy polling
Evidence/logs          factual, scoped, retrievable
Cross-session resume   proven
Restart recovery       no false success
Secret promotion       zero plaintext leaks into DMF
Legacy tools           regression-safe
Full tests             all PASS
Performance gates      PASS
Live canary             PASS
```

Final decision:

```text
STABLE / NOT STABLE
Reason/evidence:
```
