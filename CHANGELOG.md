# Changelog

All notable stable Agent Core changes are recorded here. The project follows semantic versioning for release tags and package artifacts.

## Unreleased

### Added

- Native GitHub Fabric with direct GitHub REST API access, ephemeral authenticated HTTPS Git transport, dedicated GitHub Packages authentication, route-aware MCP tools, destructive-operation guards, and tracked plugin guidance without requiring interactive GitHub CLI login.

## [0.5.0] - 2026-08-26 — Stable

### Added

- Deterministic Memory Fabric backed by local SQLite with provenance, deterministic retrieval, redaction, backup/recovery and integrity checks.
- Local Continuity Ledger for task state, checkpoints, blockers, deferred work and bounded next-work frontiers across routes/sessions.
- Deterministic Execution Fabric with persisted DAGs, hard dependencies, bounded concurrency, explicit retry/cancel, factual attempt logs and result markers.
- Persisted event journal and event-driven wake behavior with persist-before-signal semantics and no busy database polling.
- Cross-route execution continuation and restart reconciliation that marks missing-result work interrupted rather than inventing success.
- Execution-to-DMF bridge that promotes structured/redacted evidence while keeping raw stdout/stderr out of semantic memory.
- Automatic capability routing with principal-bound route contexts and audited native-ready skill loading.
- Unified Windows launcher/tray lifecycle with watchdog recovery, tunnel supervision, OAuth reset/re-auth and optional autostart.
- Portable root resolution so the complete Agent Core folder can be relocated without hard-coding a project drive/path.
- Stable release automation, reproducible plugin/runtime bundles, SHA-256 manifests and GitHub Packages publication under the `stable` channel.

### Changed

- Execution is enabled by default after staged acceptance, performance and recovery gates.
- SQLite execution WAL handling now uses explicit durable checkpoint boundaries to keep shutdown/restart behavior bounded after real workloads.
- Documentation is consolidated around canonical architecture/operator guides; historical implementation scratch plans and per-task checkpoints are retained in Git history instead of the current tree.
- Repository presentation, plugin documentation and release metadata are normalized for a cleaner private-repository surface.

### Security

- Custom Agent Core API-key and OAuth behavior remain isolated from source/package artifacts.
- Capability/tool scope is constrained by authenticated principal/project routing and allowed workspace roots.
- Raw execution logs remain local sensitive evidence; only structured/redacted evidence may enter DMF.
- Control-plane and runtime secrets are excluded from Git and release packages.

### Stability evidence

The stable runtime baseline passed:

- clean dependency install and TypeScript build;
- full regression: 68/68 test files, 267 normal tests passed, with 4 benchmark-only timing tests exercised separately;
- explicit execution performance gates: 6/6 passed;
- deterministic execution benchmark gates for 128-node DAG validation, bounded dispatch and persisted wake delivery;
- Deterministic Memory Fabric 100k-item benchmark with end-to-end recall below the certified p95 target;
- acceptance/recovery/secret-isolation gates, including cross-route continuation and no-false-success restart recovery;
- live dependency/wake canaries and post-workload graceful restart proof.

See [`docs/stability.md`](docs/stability.md) for the maintained stability baseline and release-gate policy.
