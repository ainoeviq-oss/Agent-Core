# Agent Core Windows Tray Manager Design

## Goal
Provide a native-feeling Windows lifecycle manager that starts Agent Core MCP and its OpenAI tunnel silently, keeps them healthy in the background, exposes status/control through a system-tray icon, and stops the managed bundle cleanly when the user chooses Exit.

The user should not need to keep a terminal window open before using the Agent Core ChatGPT app.

## Current Baseline
Agent Core production is `v0.5.0`, listening on `127.0.0.1:8765`, with the tunnel admin endpoint on `127.0.0.1:8787`.

The canonical tunnel profile is:
`F:\Projects\Agent-Core\tunnel-client\agent-core.yaml`

The canonical tunnel executable is:
`F:\Apps\OpenAI-Tunnel-Client\v0.0.10\tunnel-client.exe`

A currently running tunnel process was discovered with a stale in-memory command line referring to a removed pre-Agent-Core profile. The tray-manager rollout must replace that stale process safely rather than preserving the obsolete launch path.
## Chosen Architecture
Use a PowerShell WinForms tray process as the lifecycle owner, launched invisibly by a small VBScript shim and registered for current-user logon through Windows Task Scheduler.

The tray manager owns two services as one bundle:
1. Agent Core MCP runtime.
2. OpenAI tunnel client for the Agent Core tunnel.

The tray manager is not a replacement MCP server and contains no capability-routing logic. It only manages process lifecycle, local health, autostart, logs, and user controls.

### Runtime Flow
```text
Windows user logon
  -> Task Scheduler
  -> wscript.exe hidden launcher
  -> hidden PowerShell tray manager
  -> Agent Core MCP + tunnel
  -> periodic local health watchdog
```

A named per-user mutex prevents two tray managers from running simultaneously.
## File Layout
Create the following tracked files:

```text
scripts/windows/
  agent-core-tray.ps1
  launch-agent-core-hidden.vbs
  install-agent-core-autostart.ps1
  uninstall-agent-core-autostart.ps1
  Install-Agent-Core-Tray.bat
  Uninstall-Agent-Core-Tray.bat
```

Runtime-only state remains under ignored paths:

```text
runtime/tray/
  state.json
  agent-core-tray.log
  agent-core.stdout.log
  agent-core.stderr.log
  tunnel.stdout.log
  tunnel.stderr.log
```

No generated runtime state, PID file, or tray log is committed to Git.
## Process Start Contracts
### Agent Core MCP
Start Node with an absolute entry path so future ownership validation is unambiguous:

```text
C:\Program Files\nodejs\node.exe
F:\Projects\Agent-Core\dist\index.js
```

Working directory: `F:\Projects\Agent-Core`.

Set only the existing non-secret runtime configuration environment variables:
- `AGENT_CORE_DATA_DIR=F:\Projects\Agent-Core\runtime\data`
- `AGENT_CORE_LOG_DIR=F:\Projects\Agent-Core\runtime\logs`
- `AGENT_CORE_CAPABILITY_DIR=F:\Projects\Agent-Core\capabilities`
- `AGENT_CORE_ALLOWED_ROOTS=F:\Projects\Agent-Core`
- `AGENT_CORE_HOST=127.0.0.1`
- `AGENT_CORE_PORT=8765`

The tray manager never embeds or prints API keys, OAuth tokens, or raw secret file contents.
### OpenAI Tunnel
Start the canonical tunnel executable with the canonical Agent Core profile:

```text
F:\Apps\OpenAI-Tunnel-Client\v0.0.10\tunnel-client.exe run
  --profile-file F:\Projects\Agent-Core\tunnel-client\agent-core.yaml
  --harpoon.allow-plaintext-http
```

The tunnel profile continues to reference the control-plane key through its existing `file:` reference. The tray manager does not resolve that secret itself.

## Silent Launch
`launch-agent-core-hidden.vbs` uses `WScript.Shell.Run` with window style `0` and `waitOnReturn=false` to start PowerShell without a persistent console window.

PowerShell runs with:
`-NoLogo -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File agent-core-tray.ps1`.

The visible persistent UI is only the tray icon and its context menu.
## Process Ownership and Safe Adoption
The tray manager records child PIDs it starts in `runtime/tray/state.json`. Normal Exit/Restart operations stop only PIDs that still match the recorded service identity.

If the tray manager itself exits unexpectedly while managed services remain alive, the next tray instance may reclaim only state-file PIDs that still pass the full identity validation. Stale or mismatched PID records are discarded rather than stopped.

A PID match alone is insufficient. Before stopping a process, validate:
- expected port ownership when applicable;
- expected executable path;
- expected command-line signature;
- expected service role.

If a port is occupied by an unknown process, Agent Core Tray enters `Degraded` state and does not terminate that process automatically.

### Existing Process Adoption
Normal autostart never kills an unknown external process merely to take ownership.

The installer may perform a one-time controlled takeover of an already-running Agent Core bundle only when strict validation succeeds. This is used to migrate the currently running stale tunnel process.

The legacy tunnel takeover additionally requires all of:
- PID owns local port `8787`;
- executable is the expected `tunnel-client.exe`;
- command line contains `--profile-file` pointing to a non-canonical profile path whose file no longer exists.

After that validated process is stopped, only `agent-core.yaml` is used.
## Tray UI
Use `System.Windows.Forms.NotifyIcon` with a small context menu.

Menu layout:

```text
Agent Core — <Overall Status>
MCP Server: <status>
Tunnel: <status>
---------------------------
Open Agent Core Folder
Open Tunnel Admin UI
---------------------------
Restart Agent Core
Restart Tunnel
Restart All
---------------------------
Start with Windows: <On/Off>
---------------------------
Exit Agent Core
```

Status labels are informational and disabled menu items. The tooltip summarizes the overall state without opening a window.
`Open Tunnel Admin UI` opens `http://127.0.0.1:8787/ui` in the default browser only on explicit click.

## Health and Watchdog Policy
Check local health every **10 seconds**:
- Agent Core MCP: `GET http://127.0.0.1:8765/health` must return HTTP 200 with status `ok`.
- Tunnel: `GET http://127.0.0.1:8787/readyz` must return HTTP 200.

A single failed health probe does not trigger a restart. Require **3 consecutive failed probes** for the same owned service before automatic recovery.

Automatic recovery is bounded to avoid crash loops:
- at most 3 automatic restart attempts per service in a rolling 5-minute window;
- after the limit, mark the service `Faulted` and stop automatic restarts;
- a manual `Restart` action resets the fault/restart budget.

During intentional Exit or Restart, the watchdog is suspended so it cannot race the requested lifecycle action.
## Start-with-Windows Behavior
Register one current-user scheduled task named `Agent Core Tray Manager` with trigger `At log on`.

The task runs:
`wscript.exe "F:\Projects\Agent-Core\scripts\windows\launch-agent-core-hidden.vbs"`

The task runs only in the interactive logged-on user session so the tray icon is visible. It does not require elevation or highest privileges.

The tray menu checkbox reflects whether that exact scheduled task exists and points to the expected hidden launcher.

`Start with Windows` invokes only `install-agent-core-autostart.ps1` or `uninstall-agent-core-autostart.ps1` to toggle the scheduled task. It does not invoke the full tray uninstaller and does not create duplicate Startup-folder entries.

## Exit and Restart Semantics
`Exit Agent Core` performs this order:
1. set shutdown flag and disable watchdog;
2. stop the manager-owned tunnel after identity validation;
3. stop the manager-owned Agent Core MCP after identity validation;
4. remove runtime state for those PIDs;
5. dispose tray icon and exit PowerShell.

Exit does not disable the Start-with-Windows preference. If autostart remains enabled, Agent Core starts again at the next Windows logon.
`Restart Agent Core`, `Restart Tunnel`, and `Restart All` reuse the same validated stop/start routines and refresh the displayed status after completion.

The tray manager stops only its two lifecycle services. It does not recursively kill arbitrary commands previously started through Agent Core process tools; those remain governed by Agent Core's process-management APIs to avoid destructive surprise.

## Failure Handling
If startup fails because port 8765 or 8787 is occupied by an unrecognized process:
- do not terminate the occupant;
- log the conflict;
- show the affected service as `Degraded`;
- leave Restart available for manual retry after the conflict is resolved.

If required files or executables are missing, mark the service `Faulted` and include the missing path in the local tray log without opening a console window.

The tray process itself must continue running when one service is faulted so the user can inspect status, retry, or Exit.

## Security Constraints
- Never put raw credentials in script source, scheduled-task arguments, state JSON, tray tooltip, or logs.
- Never log raw OAuth tokens or API keys.
- Keep the existing tunnel `file:` secret reference intact.
- Run as the current Windows user, not SYSTEM.
- Do not broaden Agent Core workspace permissions or blocked-command policy.
- Do not disable ChatGPT permission controls.
- Do not expose additional network listeners beyond the existing local Agent Core and tunnel admin listeners.
## Installer and Uninstaller
`Install-Agent-Core-Tray.bat` is the user-facing installer entry point. It invokes the PowerShell installer, validates required paths, registers the logon task, performs the one-time validated stale-tunnel takeover when applicable, and launches the tray manager hidden.

The installer is idempotent: rerunning it updates the scheduled task and launches the tray manager only when another manager instance is not already active.

`Uninstall-Agent-Core-Tray.bat` removes only the tray-manager scheduled task and tray-manager runtime state. It does not delete Agent Core source, capability data, OAuth/key databases, tunnel profile, or secrets.

Uninstall should stop a currently running tray manager and its manager-owned MCP/tunnel bundle only after the same identity validation used by Exit.

## Observability
Tray logs are timestamped, local, and metadata-only. Record:
- manager start/exit;
- service start/stop with PID;
- health-state transitions;
- restart attempts and fault budget;
- port conflicts;
- autostart install/remove events.

Do not duplicate Agent Core MCP request/audit logs into the tray log.
## Acceptance Tests
The implementation is complete only when all of the following are verified:

1. Launching the hidden VBS produces no persistent console window and exactly one tray manager instance.
2. When both services are stopped, tray startup launches Agent Core on 8765 and the canonical tunnel on 8787.
3. Agent Core `/health` and tunnel `/readyz` return HTTP 200 after startup.
4. The tunnel process command line references `Agent-Core\tunnel-client\agent-core.yaml`, never a removed pre-Agent-Core profile.
5. Tray `Restart Agent Core`, `Restart Tunnel`, and `Restart All` recover healthy services without duplicate listeners.
6. An unknown process occupying a managed port is not killed automatically.
7. A simulated owned-service failure is recovered only after three failed watchdog probes.
8. Restart-loop budget stops repeated automatic restarts and exposes `Faulted` state.
9. `Exit Agent Core` removes the tray icon and stops the manager-owned MCP/tunnel services.
10. Autostart installation creates exactly one current-user scheduled task and relaunches the tray manager through the hidden VBS path.
11. Uninstall removes the scheduled task without deleting Agent Core data, OAuth state, tunnel profile, or secrets.
12. Existing Agent Core unit/integration tests, build, plugin build, and brand scan remain green.

## Non-Goals
- Converting Agent Core to a Windows Service.
- Adding a second MCP runtime or tunnel implementation.
- Replacing OAuth, API-key, routing, or capability logic.
- Building a compiled .NET tray executable in this release.
- Auto-updating Node, Agent Core, or the tunnel client.
- Killing arbitrary child workloads created by Agent Core task execution.
- Changing the ChatGPT app configuration.