# Codespace v0.1 Design

Date: 2026-08-28
Status: Approved design; implementation not started
Plugin name: `codespace`

## 1. Purpose

`codespace` is a private ChatGPT plugin that turns the active GitHub Codespace into ChatGPT's development workspace.

The desired user experience is deliberately small:

1. Start or attach to the GitHub Codespace.
2. The bridge starts or repairs itself automatically.
3. ChatGPT sees the `codespace` plugin through the already-created OpenAI Tunnel.
4. ChatGPT can inspect files, edit source, run commands and tests, and manage bounded background processes inside `/workspaces/...`.

The design optimizes for operational simplicity and recovery. A connection is not considered successful merely because a process exists; it must pass MCP, tunnel runtime, health, readiness, and ChatGPT discovery gates.

## 2. Hard guardrails

The following are architectural constraints, not optional implementation preferences.

- The plugin identity is exactly `codespace`.
- The bridge is a new subsystem under `plugin/codespace/`.
- No source code, authentication store, gateway configuration, runtime state, or startup contract is imported from the legacy plugin implementation.
- The legacy plugin may be inspected only as failure history; it is not a dependency.
- The ChatGPT plugin does not use a GitHub forwarded-port URL as its stable identity.
- The ChatGPT plugin uses **Connection: Tunnel**, not **Connection: Server URL**.
- The bridge does not add a custom OAuth server.
- The bridge does not require Cloudflare, SSE, a public Codespaces port, or manual endpoint replacement.
- `CONTROL_PLANE_API_KEY` is never committed, printed, returned through an MCP tool, or inherited by the MCP server process.
- The bridge is constrained to GitHub Codespaces workspace paths under `/workspaces`.
- Normal Codespace stop/start must not require the user to reconnect the plugin or paste a new URL.
- Existing repository lifecycle hooks must be composed with, not overwritten by, the bridge startup integration.

## 3. Chosen architecture

```text
ChatGPT
   |
   v
Plugin: codespace
   |
   v
OpenAI Tunnel
   |
   | outbound-only control/data connection
   v
tunnel-client v0.0.13 managed runtime
   |
   | stdio MCP transport
   v
codespace MCP server
   |
   +-- workspace filesystem
   +-- text search
   +-- foreground commands
   +-- bounded background processes
   +-- Git through the workspace shell
   |
   v
/workspaces/<active-repository>
```

### Why this architecture

GitHub Codespaces forwarded-port URLs are an implementation detail of a running Codespace and are not a suitable permanent connector identity. The OpenAI Tunnel is the stable connector anchor; the Codespace is replaceable compute behind it.

`tunnel-client` v0.0.13 provides a native managed runtime surface. Its `runtimes connect` command supports both an existing `--tunnel-id` and a local stdio `--mcp-command`, so the bridge does not need a local HTTP listener merely to reach ChatGPT.

## 4. Repository boundary

All new bridge source belongs under:

```text
plugin/codespace/
```

Target shape:

```text
plugin/codespace/
├── package.json
├── src/
│   ├── server.ts
│   ├── workspace.ts
│   ├── filesystem.ts
│   ├── commands.ts
│   ├── processes.ts
│   └── results.ts
├── scripts/
│   ├── install-tunnel-client.sh
│   ├── ensure-running.sh
│   ├── start-mcp.sh
│   └── verify.sh
├── config/
│   └── tunnel.json
├── runtime/                 # ignored/generated
│   ├── profiles/
│   ├── logs/
│   └── processes/
└── tests/
    ├── workspace.test.ts
    ├── filesystem.test.ts
    ├── commands.test.ts
    ├── processes.test.ts
    └── mcp.integration.test.ts
```

The exact file split may be refined during implementation, but the subsystem boundary must remain `plugin/codespace/` and must not depend on the legacy plugin directory.

## 5. Tunnel configuration

The user has already created the OpenAI Tunnel named `Codespace` and created a restricted runtime API key with Tunnels Read + Use.

### Runtime credential

The GitHub Codespaces secret name is:

```text
CONTROL_PLANE_API_KEY
```

The bridge checks only whether this variable is present. It never logs the value.

### Tunnel identity

The tunnel ID is an identifier, not an API credential. The bridge may keep the selected tunnel ID in bridge configuration so a Codespace rebuild can reattach without asking the user to paste it again.

The runtime API key remains separate and secret.

### Managed runtime

The persistent runtime alias is:

```text
codespace
```

The intended managed-runtime form is conceptually:

```bash
tunnel-client runtimes connect \
  --alias codespace \
  --tunnel-id <configured-tunnel-id> \
  --profile codespace \
  --profile-dir <plugin/codespace/runtime/profiles> \
  --runtime-api-key env:CONTROL_PLANE_API_KEY \
  --mcp-command "<sanitized MCP launcher>"
```

The MCP launcher must remove tunnel-control credentials before starting Node. At minimum it unsets:

```text
CONTROL_PLANE_API_KEY
OPENAI_ADMIN_KEY
```

The MCP process therefore cannot expose the tunnel credential through `execute_command`, environment inspection, or tool output.

## 6. Tunnel-client installation policy

Version `v0.0.13` is the initial pinned version.

Installation rules:

- Detect Codespace CPU architecture.
- Download only the matching official release asset.
- Download the official SHA256 manifest.
- Verify the binary checksum before installation.
- Keep the installed binary in bridge-owned runtime/tooling storage rather than modifying unrelated system packages.
- Reuse a verified installed binary on later starts.
- A version change is an explicit bridge update, not an implicit `latest` download on every startup.

This prevents startup behavior from changing unexpectedly when a new tunnel-client release appears.

## 7. MCP server

The server is a small Node/TypeScript MCP stdio server. It does not expose an HTTP port.

### Server identity

- Name: `codespace`
- Version: `0.1.0`
- Transport: stdio

The server writes protocol messages only to stdout as required by MCP. Operational logs go to stderr or bridge log files so log text cannot corrupt the protocol stream.

## 8. Workspace resolution

The server resolves one active workspace root at startup.

Resolution order:

1. An explicit bridge workspace override, when configured.
2. The repository root containing the running bridge when that root is under `/workspaces`.
3. A single valid repository candidate under `/workspaces`.
4. Fail closed with an actionable error if resolution is ambiguous.

Every filesystem and command path is canonicalized before use.

A requested path is valid only when its resolved real path remains inside the selected workspace root. `..`, symlink traversal, alternate absolute paths, and path normalization must not escape the workspace boundary.

## 9. v0.1 tool surface

The initial tool surface stays intentionally small. Git remains available through `execute_command`; dedicated Git tools are deferred until evidence shows they improve reliability.

### `codespace_status`

Read-only. Returns:

- bridge version
- workspace root
- repository branch when available
- runtime platform
- process manager health

It must not return environment variables or credentials.

### `list_directory`

Read-only directory listing inside the workspace.

Inputs:

- `path`
- optional bounded depth
- optional result limit

### `read_file`

Read-only UTF-8 file read with optional line/byte bounds.

### `read_multiple_files`

Read-only bounded batch read for several UTF-8 files.

### `search_files`

Read-only filename or UTF-8 content search under the workspace.

Searches are bounded by maximum result count and do not descend outside the workspace through symlinks.

### `write_file`

Mutating. Creates or replaces one UTF-8 file inside the workspace.

Parent directories may be created only inside the workspace.

### `edit_file`

Mutating. Exact replacement editing.

The operation rejects ambiguous edits when the number of matches differs from `expectedReplacements`. This avoids silent multi-location edits.

### `execute_command`

Mutating/open-world. Runs one `/bin/bash -lc` command in a validated working directory inside the workspace.

Controls:

- explicit or default workspace cwd
- bounded timeout
- bounded stdout/stderr capture
- no inherited tunnel-control credential
- process exit code and timeout status returned separately from output

### `start_process`

Mutating/open-world. Starts a long-running workspace process and returns an opaque session ID.

### `read_process_output`

Read-only. Returns bounded stdout/stderr plus current process state for a session owned by this server.

### `stop_process`

Mutating. Stops one owned process session and is idempotent for an already-terminal session.

### `list_processes`

Read-only. Lists only bridge-owned process sessions.

## 10. Process management

Background process state is bridge-owned and isolated from the tunnel-client managed runtime.

Requirements:

- Each session receives an opaque ID.
- stdout and stderr are bounded and persisted under `plugin/codespace/runtime/`.
- The manager records pid/process-group identity and start/terminal timestamps.
- Process operations cannot address arbitrary system PIDs; only known bridge sessions are accepted.
- On bridge startup, stale session metadata is reconciled rather than assumed alive.
- Stopping the bridge does not kill the tunnel-client supervisor by mistake.

## 11. Startup and repair lifecycle

A single idempotent entry point owns startup:

```text
plugin/codespace/scripts/ensure-running.sh
```

It is safe to call repeatedly.

### Startup sequence

```text
Codespace start/attach
      |
      v
resolve repository/workspace
      |
      v
verify CONTROL_PLANE_API_KEY exists
      |
      v
verify/install tunnel-client v0.0.13
      |
      v
build bridge when source is newer than output
      |
      v
run MCP self-test
      |
      v
create/repair managed runtime alias `codespace`
      |
      v
tunnel-client runtimes status codespace --json
      |
      +-- process_running = true
      +-- healthy = true
      +-- ready = true
      |
      v
READY
```

The lifecycle hook in `.devcontainer` invokes this entry point without replacing unrelated existing lifecycle actions.

### Recovery behavior

If the managed runtime metadata exists but the process is dead, startup reconnects it.

If the profile is stale or points at a different MCP command, startup repairs the bridge-owned profile and reconnects.

If the secret is missing, startup reports one clear blocker and does not create a half-configured runtime.

If readiness fails, startup keeps the failure evidence in bridge logs and reports the exact failing gate.

## 12. Success semantics

The word `READY` is reserved for a fully proven state.

A start is successful only when all of these are true:

1. The bridge builds successfully.
2. An MCP stdio integration probe can initialize the server and list the expected tools.
3. Workspace boundary tests pass.
4. `tunnel-client runtimes status codespace --json` reports the managed process running.
5. Tunnel health is healthy.
6. Tunnel readiness is ready.
7. The connected ChatGPT plugin can discover the tool list.
8. A final smoke test from ChatGPT successfully performs one repository read and one harmless command such as `git status --short` or `pwd`.

A process merely being launched is not success.

## 13. Error handling

Errors are returned as small structured results with a stable code plus a human-readable message.

Important error families include:

- workspace unavailable or ambiguous
- path outside workspace
- file too large / non-UTF-8 where unsupported
- edit match-count mismatch
- command timeout
- command output truncated
- unknown process session
- missing runtime key
- tunnel-client checksum/version failure
- managed runtime launch failure
- tunnel unhealthy
- tunnel not ready

Sensitive values are never embedded in an error message.

## 14. Logging

Bridge logs live under `plugin/codespace/runtime/logs/` and are ignored by Git.

Logs may contain:

- timestamps
- gate names
- process/session IDs
- command exit status
- output byte counts
- tunnel runtime state fields that are not credentials

Logs must not contain:

- `CONTROL_PLANE_API_KEY`
- admin keys
- copied environment dumps
- arbitrary secret-file contents

## 15. Testing strategy

### Unit tests

Cover at minimum:

- workspace resolution
- canonical path containment
- symlink escape rejection
- exact edit match counts
- command cwd enforcement
- timeout behavior
- output truncation
- process ownership and terminal reconciliation
- credential removal from the MCP child environment

### MCP integration test

Spawn the built MCP server through stdio with an MCP client and prove:

- initialize succeeds
- expected server identity is returned
- expected tool set is present
- one temporary-workspace read works
- one temporary-workspace write/edit works
- one harmless command works

### Tunnel integration test

Using the configured tunnel and runtime key:

1. Run the bridge verification script.
2. Connect/repair alias `codespace` through `tunnel-client runtimes connect`.
3. Read `tunnel-client runtimes status codespace --json`.
4. Require explicit running, healthy, and ready state.
5. Stop/restart the bridge-managed runtime once and prove repair returns it to ready.

### ChatGPT acceptance test

In the ChatGPT New Plugin dialog:

- Name: `codespace`
- Connection: Tunnel
- Tunnel: the already-created `Codespace` tunnel

Then prove from ChatGPT:

- `codespace_status`
- `read_file` on a known repository file
- `execute_command` with a harmless repository command

## 16. Deferred features

Not part of v0.1:

- public app-directory submission
- custom OAuth
- public HTTP MCP endpoint
- Cloudflare gateway
- dedicated GitHub API wrapper tools
- dedicated Git tool family
- binary-file editing
- GUI/browser automation
- multi-Codespace routing
- arbitrary host filesystem access outside `/workspaces`
- automatic tunnel CRUD requiring an admin key

These features require separate evidence and approval before entering the bridge.

## 17. Acceptance criteria

`codespace` v0.1 is complete only when:

- the new subsystem is isolated under `plugin/codespace/`
- setup does not require a public Codespace port or Server URL
- setup does not require custom OAuth
- the existing runtime key is consumed only by tunnel-client
- the MCP child process does not inherit the tunnel runtime key
- the plugin can work directly in the active `/workspaces/...` repository
- normal Codespace restart repairs/reconnects automatically
- build/test/verification gates are reproducible from one verification command
- managed runtime status proves running + healthy + ready
- ChatGPT successfully executes the final read + command smoke test through the plugin

## 18. Implementation invariant

When implementation choices conflict with this document, prefer the choice that removes setup steps, removes public ingress, narrows secret exposure, and keeps the bridge independently testable.

Do not expand scope merely because an older subsystem already implements more features.