# Agent Core Unified Portable Launcher Acceptance

Date: 2026-08-25
Canonical root: F:\Projects\Agent-Core

## Completed
- Start-Agent-Core.bat is the single public startup entrypoint.
- The launcher builds/bootstrap dependencies, performs controlled takeover, starts the tray manager hidden, and waits for both MCP and tunnel health.
- Tray manager owns Agent Core, tunnel, watchdog recovery, restart controls, OAuth reset/re-auth, and optional autostart.
- Node and tunnel executable discovery no longer depends on the Agent Core project drive; explicit environment overrides remain available.
- Tunnel control-plane key reference is project-relative (ile:secrets/control-plane-api-key-restored.txt).
- Autostart contract uses a stable %LOCALAPPDATA%\AgentCore locator instead of embedding the project root in Scheduled Tasks.
- Moving the stopped Agent Core folder is supported: move the complete folder, then run Start-Agent-Core.bat once from the new root to rebind paths and refresh an existing autostart locator.

## Folder cleanup
Deleted after supersession/health checks:
- F:\Projects\Agent-Core-Migration-Backups
- F:\Projects\Agent-Core-Recovered
- F:\Projects\Agent-Core-Tray-Work

Final matching top-level folder count under F:\Projects: 1 (Agent-Core).

## Verification evidence
- Public launcher live startup: success; MCP 8765 and tunnel admin 8787 healthy.
- Idempotent second launch: exit 0; existing Agent Core and tunnel listener PIDs preserved.
- Exact tray manager count after relaunch: 1.
- Custom Agent Core API-key call to gent_core_status: HTTP 200, no MCP error; key contents never logged.
- Fresh build via public launcher: success.
- Fresh full test suite after all portability/cleanup changes: 29 test files, 117 tests passed, exit 0.
- Portable launcher/autostart focused gate: 8/8 passed.
- Full tray lifecycle gate: 21/21 passed.
- Production launcher/tray scan: zero hardcoded F:\Projects\Agent-Core / E:\Projects\Agent-Core project-root references.

## Operational constraint
Do not move the project directory while Agent Core/tunnel are running. Use tray Exit Agent Core, move the complete folder, then run Start-Agent-Core.bat from the new location.

Detailed execution log: untime\verification\unified-portable-launcher-task.log.