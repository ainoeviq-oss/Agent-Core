# Stability Baseline

This document is the maintained release-facing summary of Agent Core's certified core behavior. Historical implementation checkpoints remain available in Git history, but are intentionally not carried in the current repository tree.

## Certified core

The current stable baseline covers:

- OAuth/MCP availability and custom Agent Core key authentication;
- Deterministic Memory Fabric integrity and deterministic recall;
- Local Continuity snapshot/rehydration;
- dependency-correct concurrent command execution;
- persisted event-driven wake without busy polling;
- factual per-attempt logs/result markers;
- cross-route continuation;
- restart recovery with no false success;
- secret-safe execution-to-memory promotion;
- Windows launcher/tray graceful shutdown and restart;
- legacy operational-tool regression safety.

## Last core certification

The final continuity/execution core certification was completed on 2026-08-26 after the execution WAL durability fix and staged default-enabled rollout.

### Regression gate

```text
npm ci          PASS
npm run build   PASS
npm test        PASS
```

Certified regression totals:

- test files: 68 / 68 passed;
- normal tests: 267 passed;
- benchmark-only timing tests: 4, executed separately under performance-gate mode;
- explicit performance-gate tests: 6 / 6 passed.

### Execution performance gate

Certified isolated measurements:

```text
DAG validation @ 128 nodes p95   1.916 ms   target < 50 ms
ready dispatch p95               23.586 ms  target < 100 ms
persisted wake delivery p95      29.667 ms  target < 250 ms
max observed concurrency          4 / 4
max event queries per wait        2
```

The measurements describe the validated environment; correctness is governed by persisted state and tests rather than timing assumptions.

### Memory scale gate

The 100k-item Deterministic Memory Fabric benchmark passed with SQLite integrity `ok` and end-to-end preflight/recall p95 of 67.137 ms against the certified `<150 ms` target.

### Acceptance and recovery

Final acceptance coverage proved:

- dependency-correct parallel scheduling;
- a dependent node can begin after its actual dependency succeeds while an unrelated slow node keeps running;
- fresh same-principal routes can continue owned active execution;
- restart recovery treats a valid terminal result marker as authority;
- missing terminal evidence becomes `interrupted`, never inferred success;
- raw stdout/stderr is not promoted wholesale into DMF;
- synthetic secret evidence does not appear as plaintext in DMF search/export/database paths.

### WAL / graceful exit proof

Execution SQLite automatic WAL checkpointing was replaced with explicit durable boundaries at graph/dynamic-graph/terminal-run transitions. After a real live execution workload, the corrected runtime demonstrated a clean old-process exit during controlled restart and a healthy replacement service.

## Release gate

Stable certification is performed locally by the Agent Core execution authority. Every stable release must pass the local gates below before publication. Once those local gates pass and the build is declared stable, that evidence is authoritative and must not be repeated through GitHub Actions or any other CI runner. GitHub Actions is disabled for this repository and is not an allowed verification or publication path.

The local release gates are:

| Gate | Requirement |
|---|---|
| Dependencies | clean `npm ci` |
| Build | TypeScript build passes |
| Regression | full test suite passes |
| Brand | tracked-source brand scan passes |
| Release metadata | package/server/changelog versions consistent; README remains version-neutral |
| Security packaging | no secrets/runtime/capability caches in release staging |
| Plugin package | tracked-core plugin bundle builds successfully |
| Artifact integrity | SHA-256 checksums generated for published assets |
| GitHub Release | release is published only after verification succeeds |
| GitHub Package | plugin package publishes successfully under the stable channel |

If any local gate fails, local publication stops. After the local gates pass, publication proceeds directly from the verified local artifacts through Native GitHub Fabric and GitHub Packages. CI must not rerun those gates or block the release.

## Evidence policy

Agent Core distinguishes semantic conclusions from operational evidence:

```text
raw stdout/stderr       -> local execution evidence only
execution events        -> execution journal
verified artifact/hash  -> structured evidence
accepted decision       -> DMF / continuity checkpoint
semantic task completed -> explicit task checkpoint only
```

A process disappearing, a timeout, or a restart is never sufficient evidence of success.
