# Agent Core Windows Tray Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start Agent Core MCP and its OpenAI tunnel silently as one Windows tray-managed bundle, keep both healthy, provide safe restart/exit controls, and optionally launch the manager automatically at user logon.

**Architecture:** A single PowerShell WinForms tray process owns lifecycle state for Agent Core MCP and the canonical OpenAI tunnel. A VBScript shim provides silent launch, Task Scheduler provides current-user logon autostart, and strict port/executable/command-line identity checks prevent the manager from killing unrelated processes.

**Tech Stack:** Windows PowerShell 5.1+, .NET WinForms/System.Drawing, WMI/CIM, Windows Task Scheduler, VBScript/WScript, Node.js 24+, Vitest 4 for automated regression tests.

**Spec:** `docs/superpowers/specs/2026-08-24-agent-core-tray-manager-design.md`

## Global Constraints
- Production Agent Core remains `v0.5.0` on `127.0.0.1:8765`.
- Canonical tunnel admin endpoint remains `127.0.0.1:8787`.
- Canonical tunnel profile is `F:\Projects\Agent-Core\tunnel-client\agent-core.yaml`.
- Canonical tunnel executable is `F:\Apps\OpenAI-Tunnel-Client\v0.0.10\tunnel-client.exe`.
- Run as the current Windows user, never SYSTEM, and do not require highest privileges.
- Never embed, print, or persist raw API keys, OAuth tokens, or secret file contents.
- Never terminate a process based only on PID, executable name, or port ownership.
- Runtime state/logs remain under ignored `runtime/tray/`.
- Watchdog interval is 10 seconds; recovery starts only after 3 consecutive failed probes.
- Automatic restart budget is at most 3 attempts per service in a rolling 5-minute window.
- Do not modify Agent Core MCP routing, auth, capability, workspace, or blocked-command behavior.
- Do not change ChatGPT app configuration.

---
## File Structure

Tracked implementation files:

```text
scripts/windows/
  agent-core-tray.ps1                 # tray UI, lifecycle, watchdog, state, ownership validation
  launch-agent-core-hidden.vbs        # no-console production launcher
  install-agent-core-autostart.ps1    # scheduled-task registration/update and controlled takeover entry
  uninstall-agent-core-autostart.ps1  # scheduled-task removal only
  Install-Agent-Core-Tray.bat         # user-facing install/start entry
  Uninstall-Agent-Core-Tray.bat       # user-facing uninstall/stop entry
```

Tracked tests:

```text
tests/tray-manager.test.ts            # lifecycle, identity, health, restart-budget, single-instance logic
tests/tray-autostart.test.ts          # VBS/task/install/uninstall contracts and non-secret assertions
```

Ignored runtime state:

```text
runtime/tray/state.json
runtime/tray/agent-core-tray.log
runtime/tray/agent-core.stdout.log
runtime/tray/agent-core.stderr.log
runtime/tray/tunnel.stdout.log
runtime/tray/tunnel.stderr.log
```

### Testability Contract
`agent-core-tray.ps1` exposes a non-UI diagnostic mode only for tests and installers:

```powershell
param(
  [ValidateSet('Tray','Probe','StartBundle','StopBundle','RestartBundle','ControlledTakeover')]
  [string]$Mode = 'Tray',
  [string]$ConfigPath = ''
)
```

Production launch uses the default `Tray` mode. Automated tests pass a temporary JSON config through `-ConfigPath` so no test may bind to production ports or terminate production PIDs.

---
### Task 1: Lifecycle configuration, state, and process identity foundation

**Files:**
- Create: `scripts/windows/agent-core-tray.ps1`
- Create: `tests/tray-manager.test.ts`

**Interfaces:**
- Produces `Get-AgentCoreTrayConfig`, `Read-TrayState`, `Write-TrayState`, `Get-PortOwnerProcess`, `Test-ServiceIdentity`, `Get-ServiceStatus`, `Reconcile-TrayState`, and per-user mutex helpers.
- Later tasks must use these functions rather than querying/killing processes independently.

- [ ] **Step 1: Write failing tests for config and state isolation.** Create a temp config that redirects runtime paths and ports away from production:

```ts
const config = {
  root: tempRoot,
  trayRuntimeDir: path.join(tempRoot, 'runtime', 'tray'),
  agentCorePort: 18765,
  tunnelPort: 18787,
  nodeExe: process.execPath,
  agentCoreEntry: path.join(tempRoot, 'fake-agent-core.mjs'),
  tunnelExe: process.execPath,
  tunnelProfile: path.join(tempRoot, 'agent-core.yaml'),
  watchdogIntervalSeconds: 10,
  failureThreshold: 3,
  restartLimit: 3,
  restartWindowSeconds: 300,
};
```

Assert `Probe` creates no production process, writes no secret-like values, and returns machine-readable JSON status.

- [ ] **Step 2: Write failing process-identity tests.** Start disposable child processes and assert a PID is accepted only when port owner, executable path, and command-line signature all match the service contract.

- [ ] **Step 3: Write failing stale-state tests.** Seed `state.json` with a dead PID, a live-but-mismatched PID, and a live fully-valid owned PID. Assert dead/mismatched entries are discarded without stop, while the valid PID is reclaimed into current manager ownership without restart.

- [ ] **Step 4: Write failing single-instance tests.** Start one diagnostic manager instance holding a test mutex, attempt a second instance, and assert the second exits with a distinct `already_running` result without touching service processes.

- [ ] **Step 5: Run the focused test file and verify RED.**

```powershell
Set-Location F:\Projects\Agent-Core
npm test -- tests/tray-manager.test.ts
```

Expected: failures because `agent-core-tray.ps1` and its diagnostic contract do not exist yet.
- [ ] **Step 6: Implement the configuration and state contract.** The script must start with strict mode and use one normalized config object:

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Read-TrayState([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

function Write-TrayState([string]$Path, [hashtable]$State) {
  $dir = Split-Path -Parent $Path
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  $State | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Path -Encoding UTF8
}
```

State JSON may contain service role, PID, executable path, the validated command signature used for ownership, adoption origin, start timestamp, health state, and restart metadata only. It must never contain environment secret values.

- [ ] **Step 7: Implement strict identity validation.** `Test-ServiceIdentity` must require all configured signals:

```powershell
function Test-ServiceIdentity($ProcessInfo, $Expected) {
  if (-not $ProcessInfo) { return $false }
  if ([IO.Path]::GetFullPath($ProcessInfo.ExecutablePath) -ne [IO.Path]::GetFullPath($Expected.ExecutablePath)) { return $false }
  if ($ProcessInfo.ProcessId -ne $Expected.PortOwnerPid) { return $false }
  foreach ($token in $Expected.CommandLineTokens) {
    if ($ProcessInfo.CommandLine -notlike "*$token*") { return $false }
  }
  return $true
}
```

Use CIM `Win32_Process` for executable/command line and `Get-NetTCPConnection` for port-owner PID. Never call `Stop-Process` before this function succeeds.

- [ ] **Step 8: Implement per-user mutex acquisition/release.** Use a name derived from the current user SID so two Windows users do not share the same mutex namespace.

- [ ] **Step 9: Run focused tests and verify GREEN.**

```powershell
npm test -- tests/tray-manager.test.ts
```

- [ ] **Step 10: Commit.**

```powershell
git add scripts/windows/agent-core-tray.ps1 tests/tray-manager.test.ts
git commit -m "feat: add Agent Core tray lifecycle foundation"
```

---
### Task 2: Safe service start/stop and controlled takeover

**Files:**
- Modify: `scripts/windows/agent-core-tray.ps1`
- Modify: `tests/tray-manager.test.ts`

**Interfaces:**
- Produces `Start-AgentCoreService`, `Start-TunnelService`, `Stop-OwnedService`, `Start-Bundle`, `Stop-Bundle`, and `Invoke-ControlledTakeover`.
- Consumes Task 1 identity/state helpers exclusively for ownership decisions.

- [ ] **Step 1: Write failing isolated start/stop tests.** Use temp ports and disposable fake service scripts. Assert StartBundle creates two state entries, both listeners become healthy, and StopBundle stops exactly those two owned processes.

- [ ] **Step 2: Write failing port-conflict test.** Occupy a test port with an unrelated process whose command line does not match. Assert StartBundle returns `Degraded`, leaves the occupant alive, and does not overwrite it in `state.json`.

- [ ] **Step 3: Write failing controlled-takeover tests.** Cover all cases:
- healthy existing MCP: owns configured MCP port + expected Node executable + Agent Core entry command signature + `/health` reports `ok` => adopt PID in place without restart;
- valid stale tunnel: expected tunnel executable + owns configured tunnel port + `--profile-file` points to a non-canonical path that no longer exists => stop/migrate allowed;
- any missing signal, unhealthy MCP, unknown executable, or existing non-canonical tunnel profile => takeover denied and process remains alive.

- [ ] **Step 4: Run focused tests and verify RED.**

```powershell
npm test -- tests/tray-manager.test.ts
```
- [ ] **Step 5: Implement Agent Core start with absolute paths and non-secret environment.** Use `System.Diagnostics.ProcessStartInfo`, redirect stdout/stderr to ignored runtime logs, and set only the six approved `AGENT_CORE_*` variables from the spec.

```powershell
$psi = New-Object Diagnostics.ProcessStartInfo
$psi.FileName = $Config.nodeExe
$psi.Arguments = ('"{0}"' -f $Config.agentCoreEntry)
$psi.WorkingDirectory = $Config.root
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.EnvironmentVariables['AGENT_CORE_PORT'] = [string]$Config.agentCorePort
```

Do not copy the parent environment into logs or state.

- [ ] **Step 6: Implement canonical tunnel start.** The command must contain exactly the canonical profile path:

```text
tunnel-client.exe run --profile-file F:\Projects\Agent-Core\tunnel-client\agent-core.yaml --harpoon.allow-plaintext-http
```

- [ ] **Step 7: Implement `Stop-OwnedService`.** Re-read process metadata immediately before stop, validate identity again, then use graceful close/termination with a bounded wait and a final force stop only for that revalidated PID.

- [ ] **Step 8: Implement controlled takeover.** It is callable only through `ControlledTakeover` mode/installer path, never automatically from ordinary watchdog startup. The flow is:

```text
8765 occupied -> validate Node + Agent Core command signature + healthy /health -> write adopted MCP identity to state, do not restart
8787 occupied by canonical healthy tunnel -> adopt validated canonical tunnel PID
8787 occupied by validated stale missing-profile tunnel -> stop only that PID -> Start-TunnelService with agent-core.yaml
any unknown/mismatched occupant -> Degraded/Faulted result, no termination
```

- [ ] **Step 9: Run tests and verify GREEN.**

```powershell
npm test -- tests/tray-manager.test.ts
```

- [ ] **Step 10: Commit.**

```powershell
git add scripts/windows/agent-core-tray.ps1 tests/tray-manager.test.ts
git commit -m "feat: manage Agent Core tray service bundle safely"
```

---
### Task 3: Health watchdog and bounded recovery

**Files:**
- Modify: `scripts/windows/agent-core-tray.ps1`
- Modify: `tests/tray-manager.test.ts`

**Interfaces:**
- Produces `Test-AgentCoreHealth`, `Test-TunnelHealth`, `Update-HealthState`, `Can-AutoRestart`, `Record-RestartAttempt`, and `Invoke-WatchdogTick`.
- Consumes Task 2 start/stop functions; watchdog code must never stop a process directly.

- [ ] **Step 1: Write failing health-probe tests.** Fake HTTP endpoints should cover 200/healthy, timeout, non-200, malformed Agent Core JSON, and unavailable tunnel endpoints.

- [ ] **Step 2: Write failing three-strike recovery test.** Two consecutive failures must not restart. The third consecutive failure must call the owned-service restart path exactly once and reset the failure counter after health returns.

- [ ] **Step 3: Write failing rolling-budget test.** Four restart triggers inside 300 seconds must result in exactly three restart attempts; the fourth transitions that service to `Faulted` and suppresses automatic restart.

- [ ] **Step 4: Write failing manual-reset test.** A manual restart clears consecutive failures and the restart-attempt window for that service.

- [ ] **Step 5: Run focused tests and verify RED.**

```powershell
npm test -- tests/tray-manager.test.ts
```
- [ ] **Step 6: Implement bounded health probes.** Use short request timeouts and return structured status rather than throwing into the WinForms event loop.

```powershell
function Test-AgentCoreHealth($Config) {
  try {
    $response = Invoke-RestMethod -Uri "http://127.0.0.1:$($Config.agentCorePort)/health" -TimeoutSec 2
    return ($response.status -eq 'ok')
  } catch { return $false }
}
```

Tunnel health is successful only when `/readyz` returns HTTP 200.

- [ ] **Step 7: Implement restart history as timestamps per service.** Prune entries older than 300 seconds before every budget decision; never persist an unbounded history array.

- [ ] **Step 8: Implement `Invoke-WatchdogTick`.** Skip recovery while `$script:LifecycleActionInProgress` or `$script:ShutdownRequested` is true. Update menu status through a callback rather than directly coupling watchdog logic to WinForms controls.

- [ ] **Step 9: Run focused tests and verify GREEN.**

```powershell
npm test -- tests/tray-manager.test.ts
```

- [ ] **Step 10: Commit.**

```powershell
git add scripts/windows/agent-core-tray.ps1 tests/tray-manager.test.ts
git commit -m "feat: add bounded Agent Core tray watchdog"
```

---
### Task 4: WinForms tray UI and silent launcher

**Files:**
- Modify: `scripts/windows/agent-core-tray.ps1`
- Create: `scripts/windows/launch-agent-core-hidden.vbs`
- Modify: `tests/tray-manager.test.ts`
- Create: `tests/tray-autostart.test.ts`

**Interfaces:**
- Tray mode owns `NotifyIcon`, context menu, watchdog timer, and lifecycle callbacks.
- VBS launches only `agent-core-tray.ps1` in default `Tray` mode; it contains no service credentials or lifecycle logic.

- [ ] **Step 1: Write failing tray contract tests.** Static/diagnostic assertions must require menu actions for status, open folder, open admin UI, restart MCP, restart tunnel, restart all, Start with Windows, and Exit.

- [ ] **Step 2: Write failing Exit semantics test.** In a test bundle, invoke the same exit callback and assert watchdog suspension occurs before service stop, both owned services stop, and the state file no longer contains managed PIDs.

- [ ] **Step 3: Write failing silent-launcher test.** Require `WScript.Shell.Run`, window style `0`, `waitOnReturn=False`, and these PowerShell arguments:

```text
-NoLogo -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File agent-core-tray.ps1
```

Also assert the VBS contains no token resembling `agent_core_live_`, bearer credentials, OAuth tokens, or secret file contents.

- [ ] **Step 4: Run both focused test files and verify RED.**

```powershell
npm test -- tests/tray-manager.test.ts tests/tray-autostart.test.ts
```
- [ ] **Step 5: Implement the WinForms tray shell.** Load `System.Windows.Forms` and `System.Drawing`, create one `NotifyIcon`, disabled status rows, separators, action items, and a 10-second `System.Windows.Forms.Timer` that invokes `Invoke-WatchdogTick`.

- [ ] **Step 6: Implement status rendering.** Overall state precedence is `Faulted` > `Degraded` > `Starting/Stopping` > `Running`. Tooltip text must stay below Windows NotifyIcon length limits and contain no paths or secrets.

- [ ] **Step 7: Wire menu callbacks through lifecycle functions only.** For example:

```powershell
$restartAll.Add_Click({
  Invoke-ManualRestart -Service 'all'
  Refresh-TrayStatus
})

$exitItem.Add_Click({ Invoke-TrayExit })
```

`Open Agent Core Folder` uses `explorer.exe` on the configured root. `Open Tunnel Admin UI` uses `Start-Process 'http://127.0.0.1:8787/ui'` only on click.

- [ ] **Step 8: Implement the hidden VBS launcher.** Resolve the PowerShell script relative to the VBS location so repo relocation does not require editing the VBS command.

```vbscript
Set shell = CreateObject("WScript.Shell")
shell.Run command, 0, False
```

- [ ] **Step 9: Run focused tests and verify GREEN.**

```powershell
npm test -- tests/tray-manager.test.ts tests/tray-autostart.test.ts
```

- [ ] **Step 10: Commit.**

```powershell
git add scripts/windows/agent-core-tray.ps1 scripts/windows/launch-agent-core-hidden.vbs tests/tray-manager.test.ts tests/tray-autostart.test.ts
git commit -m "feat: add silent Agent Core tray interface"
```

---
### Task 5: Current-user autostart installer and uninstaller

**Files:**
- Create: `scripts/windows/install-agent-core-autostart.ps1`
- Create: `scripts/windows/uninstall-agent-core-autostart.ps1`
- Create: `scripts/windows/Install-Agent-Core-Tray.bat`
- Create: `scripts/windows/Uninstall-Agent-Core-Tray.bat`
- Modify: `scripts/windows/agent-core-tray.ps1`
- Modify: `tests/tray-autostart.test.ts`

**Interfaces:**
- Scheduled task name: `Agent Core Tray Manager`.
- Install script supports `-StartNow`, `-ControlledTakeover`, and test-only `-ContractOnly`.
- Uninstall-autostart script removes only the scheduled task; the full uninstall BAT additionally requests tray exit and removes only `runtime/tray/` after shutdown.

- [ ] **Step 1: Write failing scheduled-task contract test.** `-ContractOnly` must emit JSON describing exactly one action, trigger, and principal:

```json
{
  "taskName": "Agent Core Tray Manager",
  "executable": "wscript.exe",
  "arguments": "\"F:\\Projects\\Agent-Core\\scripts\\windows\\launch-agent-core-hidden.vbs\"",
  "trigger": "AtLogOn",
  "logonType": "Interactive",
  "runLevel": "Limited"
}
```
- [ ] **Step 2: Write failing idempotence/source tests.** The installer must use `Register-ScheduledTask -Force` for the same exact task and must not create a Startup-folder shortcut or registry Run key.

- [ ] **Step 3: Write failing uninstall-preservation tests.** Assert uninstall scripts never delete `runtime/data`, `runtime/logs`, `capabilities`, `tunnel-client/agent-core.yaml`, or `secrets`.

- [ ] **Step 4: Write failing full-uninstall shutdown test.** When a tray manager is active, the uninstaller writes a local `runtime/tray/exit.request`, waits up to 15 seconds for the manager/mutex to disappear, then removes tray runtime state. It must not directly kill an arbitrary PowerShell process.

- [ ] **Step 5: Run focused tests and verify RED.**

```powershell
npm test -- tests/tray-autostart.test.ts
```

- [ ] **Step 6: Implement current-user task registration.** Build the task with:

```powershell
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $VbsPath + '"')
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $CurrentUser
$principal = New-ScheduledTaskPrincipal -UserId $CurrentUser -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'Agent Core Tray Manager' -Action $action -Trigger $trigger -Principal $principal -Force
```

The installer must fail clearly rather than silently falling back to a different autostart mechanism.
- [ ] **Step 7: Implement tray-menu autostart toggle.** The tray process invokes only the autostart install/uninstall PowerShell helpers and refreshes the checkbox from the exact scheduled-task definition afterward.

- [ ] **Step 8: Implement full installer behavior.** `Install-Agent-Core-Tray.bat` calls the PowerShell installer with `-ControlledTakeover -StartNow`; the installer validates paths first, then performs controlled takeover, updates the scheduled task, and launches the hidden VBS only when the tray mutex is not already held.

- [ ] **Step 9: Implement full uninstaller behavior.** `Uninstall-Agent-Core-Tray.bat` requests tray exit, waits for shutdown, removes the scheduled task, and deletes only `runtime/tray/`. If no tray manager is active, it may call `agent-core-tray.ps1 -Mode StopBundle` so only revalidated state-owned services are stopped.

- [ ] **Step 10: Run focused tests and verify GREEN.**

```powershell
npm test -- tests/tray-autostart.test.ts tests/tray-manager.test.ts
```

- [ ] **Step 11: Commit.**

```powershell
git add scripts/windows tests/tray-autostart.test.ts tests/tray-manager.test.ts
git commit -m "feat: install Agent Core tray autostart"
```

---
### Task 6: Full regression, live installation, and tray acceptance

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-08-24-agent-core-tray-manager.md` only for completion checkboxes during execution.
- Runtime/system state: production Agent Core, tunnel process, `runtime/tray/`, current-user scheduled task, Windows notification area.

**Acceptance boundary:** Production source is merged only after isolated automated gates pass. The live installer may briefly restart the tunnel to migrate the stale in-memory profile, but it must preserve Agent Core runtime data, OAuth/key stores, secrets, capability registry, and the existing tunnel ID/profile.

- [ ] **Step 1: Update README with operator workflow.** Document only these user-facing commands:

```text
Install/start:   scripts\windows\Install-Agent-Core-Tray.bat
Exit temporarily: tray menu -> Exit Agent Core
Restart:          tray menu -> Restart All
Remove autostart: tray menu -> Start with Windows: Off
Full uninstall:   scripts\windows\Uninstall-Agent-Core-Tray.bat
```

Clarify that Exit does not disable next-logon autostart.

- [ ] **Step 2: Run complete pre-install regression from the feature worktree.**

```powershell
npm test
npm run build
npm run build:plugin
npm run check:brand
```

Expected: all commands exit 0; no tray runtime state is tracked.

- [ ] **Step 3: Review the source diff for destructive surface.** Confirm every process-stop path flows through `Test-ServiceIdentity`/`Stop-OwnedService`, only `runtime/tray/` is removable by uninstall, and no secret values appear in tracked scripts.
- [ ] **Step 4: Capture pre-install production identity without secrets.** Record only listener PIDs, executable paths, command-line signatures, Git HEAD, and health status for ports 8765/8787. Do not print key files or bearer values.

- [ ] **Step 5: Run the user-facing installer.**

```powershell
Set-Location F:\Projects\Agent-Core
.\scripts\windows\Install-Agent-Core-Tray.bat
```

Expected installer behavior:
- existing healthy Agent Core MCP may be adopted in place only after strict 8765 + Node executable + Agent Core command-signature validation;
- stale tunnel on 8787 is stopped only after controlled-takeover validation and replaced with the canonical `agent-core.yaml` process;
- exactly one tray-manager instance starts hidden;
- exactly one scheduled task is present.

- [ ] **Step 6: Verify live canonical identities.** Assert:
- `GET http://127.0.0.1:8765/health` => 200 + `status=ok`;
- `GET http://127.0.0.1:8787/readyz` => 200;
- tunnel command line contains `F:\Projects\Agent-Core\tunnel-client\agent-core.yaml`;
- no tunnel listener on 8787 references a missing/non-canonical profile;
- `runtime/tray/state.json` PIDs match the live validated listeners.

- [ ] **Step 7: Verify single-instance silent launch.** Run the VBS launcher again. Assert listener PIDs are not duplicated and only one tray mutex/manager remains. User visually confirms no persistent terminal window appears and the Agent Core tray icon is present.
- [ ] **Step 8: Verify manual tray controls.** Through the tray menu, run `Restart Agent Core`, `Restart Tunnel`, then `Restart All`. After each action verify the affected service returns healthy, no duplicate listener exists, and the unaffected service remains available when only one component is restarted.

- [ ] **Step 9: Verify watchdog behavior in isolated test config.** Start the test bundle, terminate one identity-validated fake owned service, and sample three 10-second watchdog ticks. Assert no recovery before tick 3, recovery on tick 3, and `Faulted` after the fourth recovery trigger inside 5 minutes when the three-attempt budget is exhausted.

- [ ] **Step 10: Verify autostart task.** Inspect `Agent Core Tray Manager` and assert its action is exactly `wscript.exe` with the canonical hidden launcher, its trigger is current-user AtLogOn, and run level is Limited. Toggle Start with Windows Off/On from the tray and verify exactly one task is removed/recreated.

- [ ] **Step 11: Verify Exit semantics.** Click `Exit Agent Core`; assert tray icon disappears, ports 8765 and 8787 stop listening, no unrelated Node/tunnel process is terminated, and the scheduled task remains installed. Launch the VBS manually and verify the bundle returns healthy silently.
- [ ] **Step 12: Verify full uninstall preservation, then reinstall final state.** Before uninstall record existence/hashes/metadata only for the canonical tunnel profile and existence of runtime data/capability/secrets directories. Run:

```powershell
.\scripts\windows\Uninstall-Agent-Core-Tray.bat
```

Assert the scheduled task and `runtime/tray/` are removed while Agent Core source/data/OAuth/capabilities/profile/secrets remain. Then rerun `Install-Agent-Core-Tray.bat` so the delivered machine ends in the requested installed/running/autostart state.

- [ ] **Step 13: Run post-install Agent Core regression and live health gate.**

```powershell
npm test
npm run build
npm run build:plugin
npm run check:brand
```

Also assert 8765 `/health` = 200, 8787 `/readyz` = 200, Git has no tracked runtime state, and the tray task is installed exactly once.

- [ ] **Step 14: Commit operator documentation.**

```powershell
git add README.md
git commit -m "docs: document Agent Core tray operation"
```

- [ ] **Step 15: Present acceptance evidence before integration.** Report test counts, listener PIDs/identity summaries, canonical tunnel profile use, scheduled-task contract, watchdog results, uninstall-preservation results, and any manual tray-visibility confirmation. Do not merge/push until the development-branch completion workflow is followed.

---

## Completion Contract
Implementation is complete only when all six tasks are checked, every automated regression is green, production ends with one healthy Agent Core MCP listener + one canonical tunnel listener + one tray manager + one current-user logon task, and no secret/runtime tray state is tracked.
