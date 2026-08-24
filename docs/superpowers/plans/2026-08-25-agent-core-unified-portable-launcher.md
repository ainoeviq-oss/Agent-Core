# Agent Core Unified Portable Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Consolidate Agent Core startup into one portable launcher and leave one canonical project folder.

**Architecture:** `Start-Agent-Core.bat` delegates to a testable PowerShell bootstrapper. The bootstrapper resolves the current project root dynamically, ensures the compiled runtime is current, launches the existing tray manager hidden, waits for MCP+tunnel health, and refreshes the autostart locator. The tray manager remains the lifecycle owner for Agent Core, tunnel, watchdog, OAuth reset, and tray actions.

**Tech Stack:** Windows batch, PowerShell 5.1+, Node.js, TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-25-agent-core-unified-portable-launcher-design.md`

## Global Constraints
- One user-facing launcher: `Start-Agent-Core.bat`.
- Preserve custom Agent Core API keys and OAuth data unless user explicitly resets OAuth.
- No hardcoded project root drive/path in production launcher/runtime scripts.
- Folder move is supported after stopping the bundle; first launch at the new location self-heals runtime/autostart location.
- Delete duplicate folders only after verification proves canonical root supersedes them.

---

### Task 1: Unified launcher contract
**Files:** create `scripts/windows/agent-core-launcher.ps1`; modify `Start-Agent-Core.bat`; test `tests/unified-launcher.test.ts`.
- [x] Write tests requiring script-relative root resolution, hidden tray launch, bootstrap/build contract, and absence of direct `node dist/index.js` in the BAT.
- [x] Run the new tests and verify RED.
- [x] Implement the launcher bootstrapper and minimal BAT delegation.
- [x] Run launcher tests and verify GREEN.

### Task 2: Portable runtime discovery
**Files:** modify `scripts/windows/agent-core-tray.ps1`, `scripts/windows/install-agent-core-autostart.ps1`, `.env.example`; test `tests/unified-launcher.test.ts`, `tests/tray-autostart.test.ts`, `tests/tray-manager.test.ts`.
- [x] Add tests for dynamic Node/tunnel discovery and relocated-root contract.
- [x] Run tests and verify RED.
- [x] Implement executable discovery and stable autostart locator under LocalAppData.
- [x] Run targeted tests and build.

### Task 3: Acceptance and duplicate-folder cleanup
**Files:** create checkpoint under `docs/superpowers/checkpoints/`; filesystem cleanup outside Git.
- [x] Verify canonical launcher build/tests and live ports 8765/8787.
- [x] Verify custom key authentication without printing the key.
- [x] Prove recovery/tray-work commits are superseded by canonical implementation.
- [x] Remove stale hidden `.worktrees` and the three duplicate roots: `Agent-Core-Migration-Backups`, `Agent-Core-Recovered`, `Agent-Core-Tray-Work`.
- [x] Re-run launcher from canonical root and record final acceptance.

