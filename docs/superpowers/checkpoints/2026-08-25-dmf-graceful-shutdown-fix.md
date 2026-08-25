# DMF Windows Graceful Shutdown Fix — Verification Checkpoint

Date: 2026-08-25 (Asia/Jakarta)
Base stable commit before fix: `a731cf1`
Workspace: `F:\Projects\Agent-Core\.worktrees\deterministic-memory-fabric`

## Why this follow-up was required

After all original Section 24 gates passed, a live-deployment preflight tested the actual Windows behavior of PowerShell `Stop-Process` against a synthetic Node.js process that registered `SIGTERM` and `SIGINT` handlers. The process terminated, but no signal marker was written (`SIGNAL_MARKER_EXISTS=False`). Therefore the previous tray implementation could hard-terminate Agent Core without running its JavaScript signal handlers.

SQLite crash recovery was already proven, but that behavior was weaker than the intended normal lifecycle contract: tray restart/exit should give the in-process memory worker a clean checkpoint/close path and reserve hard termination for a hung/legacy fallback.

## TDD RED evidence

- Runtime RED: `tests/runtime.test.ts` failed because `src/runtime/shutdown-request.ts` did not exist.
- Tray RED: the isolated Agent Core health payload had no `shutdownRequestPath`, proving the tray did not pass a graceful-shutdown channel to the child process.

## Implementation

- Added `src/runtime/shutdown-request.ts`, a bounded local file watcher with no network listener/service.
- `src/index.ts` watches `AGENT_CORE_SHUTDOWN_REQUEST_PATH` in the main Agent Core process and invokes the same idempotent `service.close()` path used by signal handlers.
- The unified tray sets `AGENT_CORE_SHUTDOWN_REQUEST_PATH` to `runtime\tray\agent-core.shutdown.request` for the Agent Core child only.
- `Stop-OwnedService` requests graceful Agent Core shutdown first and waits up to 5 seconds. It uses the previous identity-validated `Stop-Process` path only as a fallback.
- Stale shutdown request files are cleared before starting a fresh Agent Core child.
- Tunnel lifecycle remains unchanged.

## GREEN evidence

Focused gates:

- `tests/runtime.test.ts`: 4/4 PASS.
- targeted `tests/tray-manager.test.ts` lifecycle: PASS, including `graceful: true` and marker evidence.
- `npm run build`: PASS.
- PowerShell parser: 0 errors.
- `git diff --check`: exit 0.

Real compiled-runtime acceptance using `dist/index.js`:

- isolated port: 65275.
- `/health`: `status=ok`, memory enabled/healthy, state `healthy`, integrity `ok`.
- local shutdown request written.
- Agent Core process exited with code 0.
- shutdown request consumed/removed.
- SQLite DB remained present.
- no `memory.sqlite-wal` sidecar remained.
- no `memory.sqlite-shm` sidecar remained.
- `PRAGMA quick_check=ok` after exit.
- schema `user_version=1` remained readable.

Full regression after the fix:

- 48/48 test files PASS.
- 169/169 tests PASS.
- exit 0.

## Architectural consequence

Normal Windows tray restarts/exits now use an explicit in-process graceful shutdown channel instead of assuming Unix-like signal delivery from PowerShell. DMF remains part of the single Agent Core service/process architecture: the watcher is only a local filesystem poller and introduces no secondary server, model, vector service, or network listener.

Hard termination remains a bounded fallback for a hung/legacy process, backed by the already-proven SQLite WAL/crash-recovery path.
