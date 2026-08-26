# Agent Core Documentation

The current documentation tree is intentionally compact. Historical implementation plans, per-task checkpoints, and temporary architecture exports are preserved by Git history rather than kept in the active repository surface.

## Runtime architecture

- [`deterministic-memory.md`](deterministic-memory.md) — DMF storage, retrieval, redaction, backup, recovery and integrity.
- [`local-agent-continuity.md`](local-agent-continuity.md) — durable task/checkpoint/frontier state across routes and sessions.
- [`deterministic-execution-fabric.md`](deterministic-execution-fabric.md) — DAG execution, logs, events, retries, recovery and operational boundaries.
- [`multi-command-wake-workflow.md`](multi-command-wake-workflow.md) — agent-facing dependency-aware asynchronous execution behavior.
- [`github.md`](github.md) — Native GitHub Fabric credentials, REST/Git/Packages transports, destructive gates, rotation, and live read-only acceptance.

## Stability and operations

- [`stability.md`](stability.md) — maintained stability baseline and release gates.
- [`../SECURITY.md`](../SECURITY.md) — repository/runtime security model and secret boundaries.

## Roadmap

- [`roadmap/self-fork-integration.md`](roadmap/self-fork-integration.md) — planning-only design for same-model cognitive branching integrated with the existing execution and continuity fabrics.

Roadmap documents are not statements that a feature is already implemented. The live MCP capability surface remains the factual source for currently available behavior.
