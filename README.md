# Agent Core

[![Latest release](https://img.shields.io/github/v/release/rendevouz999/Agent-Core?display_name=tag&sort=semver)](https://github.com/rendevouz999/Agent-Core/releases/latest)
[![GitHub package](https://img.shields.io/badge/GitHub%20Packages-agent--core--plugin-24292f?logo=github)](https://github.com/users/rendevouz999/packages/npm/package/agent-core-plugin)

Agent Core is a **local-first, authenticated MCP control plane** that gives ChatGPT a bounded execution authority instead of an unverified shell. It combines durable memory, cross-session continuity, dependency-aware execution, evidence-backed completion, GitHub operations, and self-healing desktop or Codespaces lifecycles.

The model remains responsible for interpretation and judgment. Agent Core supplies the deterministic substrate around it: identity, policy, local state, guarded tools, process truth, recovery, and auditable evidence.

## Core capabilities

| Layer | Responsibility |
|---|---|
| MCP gateway | Streamable HTTP MCP endpoint, OAuth, custom Agent Core API keys, and bounded tool discovery |
| Workspace guard | Allowed-root filesystem and process boundaries |
| Capability routing | Principal/project routing, deferred capability search, and audited skill loading |
| Deterministic Memory Fabric | Local SQLite memory with provenance, retrieval, revision, redaction, backup, and integrity checks |
| Local Continuity | Durable task, checkpoint, blocker, decision, and next-frontier state across sessions |
| Execution Fabric | Persisted DAG execution, bounded concurrency, retries, cancellation, logs, restart recovery, and verified artifacts |
| Native GitHub Fabric | Route-aware repositories, Git, issues, pull requests, releases, REST calls, and GitHub Packages without interactive login |
| Lifecycle authority | Windows launcher/tray supervision and self-healing GitHub Codespaces startup |
| Presentation Bridge | Standalone PPTX conversion project with desktop and hosted interfaces |

**Authority order:** process truth > verified artifact truth > parsed structured interpretation > artifact/cache suggestion > workflow advice. Lower layers may help reasoning, but they do not override current execution evidence.

## Architecture

```text
ChatGPT / MCP client
        |
        v
+-------------------------------+
| Agent Core MCP + OAuth        |
| identity / route / policy     |
+---------------+---------------+
                |
   +------------+------------+------------+----------------+
   |                         |            |                |
   v                         v            v                v
Capability              Memory +      Execution      Native GitHub
routing                  Continuity      Fabric          Fabric
   |                         |         DAG + events   REST/Git/Packages
   +------------+------------+------------+----------------+
                |
                v
          Bounded actions
                |
        +-------+--------+
        |                |
        v                v
 files / processes   GitHub / evidence
```

## Clone the canonical repository

```bash
git clone https://github.com/rendevouz999/Agent-Core.git
cd Agent-Core
git switch main
```

Use `rendevouz999/Agent-Core` as the canonical source. Forks may be useful as temporary development remotes, but stable source, releases, packages, and Codespaces lifecycle updates are published from the canonical repository.

## Windows quick start

Requirements:

- Windows 10 or 11
- Node.js 24+
- the complete Agent Core folder kept intact
- a configured Secure MCP Tunnel when remote ChatGPT access is required

For normal operation, launch only:

```text
Start-Agent-Core.bat
```

The launcher resolves the current project root, installs missing dependencies, builds the runtime, performs identity-safe service takeover, and starts the tray manager in the background.

Default local endpoints:

```text
MCP      http://127.0.0.1:8765/mcp
Health   http://127.0.0.1:8765/health
Metrics  http://127.0.0.1:8765/health/metrics
```

Tray controls:

```text
Restart:        tray menu -> Restart All
OAuth re-auth:  tray menu -> Reset OAuth / Re-auth
Autostart:      tray menu -> Start with Windows: On/Off
Exit:           tray menu -> Exit Agent Core
```

`Exit Agent Core` stops only identity-validated Agent Core and tunnel processes owned by the tray lifecycle. Runtime data, logs, OAuth/key state, capabilities, and secrets remain preserved.

## GitHub Codespaces

The repository includes an automatic Linux lifecycle for disposable Codespaces hosts:

```text
postCreate -> scripts/codespace/bootstrap.sh --phase create
postStart  -> scripts/codespace/bootstrap.sh --phase start
postAttach -> scripts/codespace/ensure-running.sh --repair --phase attach
```

The lifecycle restores dependencies, rebuilds when required, starts the loopback MCP server, performs a real MCP protocol probe, registers the fixed tunnel runtime, verifies remote identity, and keeps a watchdog active. Credential values stay in ignored file-backed or GitHub Codespaces secret storage and are never committed.

For an already configured repository/account, the normal user flow is:

```text
Create, resume, or rebuild the Codespace
              -> wait for lifecycle readiness
              -> say "test koneksi" in ChatGPT
```

No tunnel ID or API key should be pasted into chat. Keep only one Codespace active against the same fixed tunnel identity at a time. See [`docs/codespaces.md`](docs/codespaces.md) for provisioning boundaries, recovery behavior, and verification commands.

## Presentation Bridge

`SubProject/Presentation-Bridge` is an independently testable PPTX conversion project with one shared UI surface for Electron desktop and hosted browser use.

```bash
cd SubProject/Presentation-Bridge
npm ci
npm run verify
npm run smoke:desktop
```

The v0.2 interface provides one-screen file selection, Google Slides / Keynote / Both targets, progress and cancellation, result cards, compatibility reporting, recent jobs, and setup dialogs. Google Slides live OAuth verification and native Keynote `.key` generation remain environment-dependent acceptance gates; unavailable targets are reported rather than presented as false success.

Every stable Agent Core release includes a credential-free source archive:

```text
presentation-bridge-v0.2.0-source.zip
```

The archive contains tracked source and documentation only. It excludes runtime jobs, secrets, generated corpus files, build output, release output, and `node_modules`.

## Tool surface

Agent Core groups its MCP tools by responsibility:

- **Identity and status** — runtime identity, readiness, bounded health metrics, workspace roots, and capability stage.
- **Filesystem and search** — bounded read/write/edit/move/info plus recursive filename/content search.
- **Processes** — guarded command execution and owned background-process lifecycle tools.
- **Capability routing** — route, search, dependency inspection, audited skill loading, and registry coverage.
- **GitHub** — repositories, Git, issues, pull requests, releases, GitHub Packages/npm, and bounded REST operations.
- **Memory** — status, search, inspect, commit, revise, forget, explain, and export.
- **Continuity** — checkpoint, status, task inspection, blockers, and actionable frontier.
- **Execution** — create/start/status/wait/log/add/retry/cancel DAG runs, verified artifact lookup, and read-only workflow advice.

Route-bound mutations require a current principal/project routing context. High-risk system, storage, privilege, and escape-path operations are rejected before execution.

## Persistence and security

```text
runtime/data/       OAuth clients, key metadata, launcher state
runtime/logs/       operational logs
runtime/memory/     Deterministic Memory Fabric SQLite + backups
runtime/execution/  execution SQLite + per-attempt evidence
capabilities/       deferred/audited capability registry
secrets/            operator-managed secrets; never packaged
```

Security boundaries:

- MCP binds to `127.0.0.1` by default.
- Agent Core API keys are stored as salted hashes; raw material is shown only at creation or rotation.
- OAuth state and GitHub credentials remain outside source control.
- Filesystem/process tools are constrained to configured workspace roots.
- Raw execution stdout/stderr remains sensitive operator evidence and is not promoted wholesale into semantic memory.
- Recovery does not infer success from a missing process or PID; durable result evidence is authoritative.
- Deferred third-party capabilities cannot become executable skills until audit gates pass.
- REST/Git and GitHub Packages credentials are separate, read lazily, redacted, and excluded from release assets.

See [`SECURITY.md`](SECURITY.md) for the complete repository security model.

## Repository layout

```text
src/                            Agent Core runtime source
tests/                          behavioral, security, recovery, and performance tests
scripts/                        build, benchmark, release, and lifecycle tooling
plugin/agent-core/              native routing and GitHub skills
plugin/codespace/               bounded Codespace MCP bridge and watchdog
SubProject/Presentation-Bridge/ standalone PPTX conversion project
docs/                           canonical architecture and operator documentation
tunnel-client/                  safe tunnel configuration example
Start-Agent-Core.bat            Windows launcher
```

## Development and verification

```bash
npm ci
npm run verify
```

Complete stable release gate and local packaging:

```bash
npm run verify:release
npm run package:release
```

GitHub Actions is intentionally disabled for this repository. Accepted local verification is authoritative; stable publication is performed directly through Native GitHub Fabric.

## Releases and packages

A stable release contains:

```text
agent-core-windows-vX.Y.Z-stable.zip
agent-core-plugin-vX.Y.Z-stable.zip
presentation-bridge-v0.2.0-source.zip
rendevouz999-agent-core-plugin-X.Y.Z.tgz
release-manifest.json
SHA256SUMS.txt
```

The ZIP and TGZ files are built from an exact clean source commit. Runtime state, credentials, secrets, local capability caches, generated jobs, and raw evidence are excluded. `SHA256SUMS.txt` provides independently verifiable hashes for every distributable asset and the manifest.

The npm-compatible plugin is published to GitHub Packages as:

```text
@rendevouz999/agent-core-plugin
```

Authenticated installation:

```bash
export NODE_AUTH_TOKEN="<GitHub token with read:packages>"
npm install @rendevouz999/agent-core-plugin --registry=https://npm.pkg.github.com
```

Do not commit `NODE_AUTH_TOKEN` or a generated `.npmrc`. Stable package publication uses a dedicated file-backed Packages credential and the `stable` dist-tag.

Release history and behavior changes are recorded in [`CHANGELOG.md`](CHANGELOG.md). Canonical operational documents begin at [`docs/README.md`](docs/README.md); GitHub credential and publication behavior is documented in [`docs/github.md`](docs/github.md).
