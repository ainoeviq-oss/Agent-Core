# Agent Core

Agent Core is a **local-first, authenticated MCP control plane** that lets ChatGPT work against a bounded Windows workspace with durable memory, dependency-aware execution, evidence-backed continuity, and an operator-owned launcher/tray lifecycle.

The design keeps semantic reasoning in the connected model while Agent Core supplies the deterministic substrate around it: authentication, workspace policy, local state, command execution, event wake, recovery, and factual evidence.

## What Agent Core provides

| Layer | Responsibility |
|---|---|
| MCP gateway | Streamable HTTP MCP endpoint and tool discovery |
| Authentication | Custom Agent Core API keys, OAuth 2.0, PKCE, refresh tokens, dynamic client registration |
| Workspace guard | Allowed-root filesystem and process boundaries |
| Capability routing | Principal-bound task routing and audited deferred skill loading |
| Deterministic Memory Fabric | Local SQLite semantic memory, provenance, retrieval, backup, integrity, redaction |
| Local Continuity | Task/checkpoint/frontier state that can be rehydrated by a later route or chat session |
| Execution Fabric | Durable DAG execution, bounded concurrency, retries, logs, restart recovery |
| Event wake | Persist-before-signal event delivery without busy database polling |
| Windows lifecycle | One launcher, tray controls, watchdog recovery, tunnel supervision, optional autostart |

## Architecture

```text
ChatGPT / MCP Client
        |
        v
+-----------------------------+
| Agent Core MCP + OAuth      |
| identity / route / policy   |
+-------------+---------------+
              |
       +------+-------+--------------------+
       |              |                    |
       v              v                    v
 Capability       DMF + Continuity    Execution Fabric
  Registry        durable context      DAG + events
       |              |                    |
       +--------------+---------+----------+
                                |
                                v
                      Verified local actions
                                |
                    +-----------+-----------+
                    |                       |
                    v                       v
              Files / processes       Evidence / logs
```

**Core rule:** the model interprets and decides; Agent Core persists, constrains, executes, and records reality.

## Quick start

Requirements:

- Windows 10/11
- Node.js 24+
- the Agent Core project folder kept intact
- Secure MCP Tunnel configured for remote ChatGPT access when needed

For normal use, launch only:

```text
Start-Agent-Core.bat
```

The launcher resolves the current project location, installs missing dependencies, builds the runtime, performs identity-safe service takeover, then starts the tray manager in the background. Internal PowerShell/VBS helpers do not need to be launched manually.

Default local endpoints:

```text
MCP     http://127.0.0.1:8765/mcp
Health  http://127.0.0.1:8765/health
```

The service remains loopback-bound. Remote ChatGPT access is provided through the configured Secure MCP Tunnel rather than by exposing the local MCP listener directly.

## Tray controls

```text
Restart:        tray menu -> Restart All
OAuth re-auth:  tray menu -> Reset OAuth / Re-auth
Autostart:      tray menu -> Start with Windows: On/Off
Exit:           tray menu -> Exit Agent Core
```

`Exit Agent Core` stops only identity-validated Agent Core and tunnel processes owned by the tray manager. Runtime data, logs, OAuth/key state, capabilities, and secrets are preserved.

## Tool surface

Agent Core groups its MCP tools by responsibility:

- **Identity & status** - runtime identity, health, workspace roots, capability stage.
- **Filesystem & search** - bounded read/write/edit/move/info and recursive filename/content search.
- **Processes** - guarded PowerShell execution plus owned background-process lifecycle tools.
- **Capability routing** - route, search, inspect dependencies, load audited native-ready skills, registry coverage.
- **Memory** - status, search, inspect, commit, revise, forget, explain, export.
- **Continuity** - checkpoint, status, task inspection, actionable frontier.
- **Execution** - create/start/status/wait/log/add/retry/cancel dependency-aware command runs.

Route-bound mutations require a current principal/project routing context. High-risk system, storage, privilege, and escape-path operations are rejected before execution.

## Persistence model

Runtime state is local and intentionally separated by concern:

```text
runtime/data/       OAuth clients, key metadata, launcher state
runtime/logs/       operational logs
runtime/memory/     Deterministic Memory Fabric SQLite + backups
runtime/execution/  execution SQLite + per-attempt evidence
capabilities/       deferred/audited capability registry
secrets/            operator-managed secrets (never packaged)
```

Generated runtime state, secrets, caches, local capability sources, and release build output are excluded from Git.

## Security boundaries

- MCP is bound to `127.0.0.1` by default.
- Agent Core API keys are persisted as salted hashes; raw key material is shown only at creation/rotation time.
- OAuth state is separate from source control.
- Filesystem/process tools are restricted to configured workspace roots.
- Raw execution stdout/stderr is treated as sensitive operator evidence and is never promoted wholesale into semantic memory.
- Execution recovery never infers success from a vanished process or PID; durable result evidence is authoritative.
- Deferred third-party capabilities cannot become executable skills until their audit gates pass.

See [`SECURITY.md`](SECURITY.md) for the repository security model.

## Repository layout

```text
src/                 Agent Core runtime source
tests/               behavioral, security, recovery and performance tests
scripts/             build, benchmark, release and Windows lifecycle tooling
plugin/agent-core/    native Agent Core plugin source
docs/                canonical architecture/operator documentation
tunnel-client/        safe tunnel configuration example
Start-Agent-Core.bat  public launcher
```

## Documentation

Start with [`docs/README.md`](docs/README.md).

Key documents:

- [`docs/deterministic-memory.md`](docs/deterministic-memory.md)
- [`docs/local-agent-continuity.md`](docs/local-agent-continuity.md)
- [`docs/deterministic-execution-fabric.md`](docs/deterministic-execution-fabric.md)
- [`docs/multi-command-wake-workflow.md`](docs/multi-command-wake-workflow.md)
- [`docs/stability.md`](docs/stability.md)
- [`docs/roadmap/self-fork-integration.md`](docs/roadmap/self-fork-integration.md) - planning only; not implemented

## Development and verification

```powershell
npm ci
npm run build
npm test
npm run check:brand
```

For the complete release gate:

```powershell
npm run verify:release
npm run package:release
```

## Plugin packaging

The tracked plugin source contains the native Agent Core Capability Router. Local audited `native_ready` skills can additionally be materialized from the deferred capability registry with:

```powershell
npm run build:plugin
```

Local generated skill packages include provenance/license evidence and remain ignored by Git. Release packaging deliberately uses a reproducible tracked-core bundle; runtime credentials, OAuth state, secrets, caches, quarantine material, and untracked capability sources are never included.

## Releases

Stable tags are built through the repository release workflow. A successful stable release is gated by dependency install, build, full tests, brand checks, release-metadata checks, package construction, checksums, GitHub Release publication, and GitHub Packages publication of the plugin source package under the `stable` dist-tag.

Release history and behavior changes are recorded in [`CHANGELOG.md`](CHANGELOG.md).
