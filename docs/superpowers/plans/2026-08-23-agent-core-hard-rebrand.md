# Agent Core Hard Rebrand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every active owned Commander/Desktop Commander identity with Agent Core, preserve machine-control behavior, and cut over the private runtime/repository/path safely with fresh Agent Core credentials.

**Architecture:** Rebrand behavior is implemented first in an isolated worktree under a new identity contract, while the current `main` runtime remains live. After tests and a zero-legacy tracked-file scan pass, create a local rollback backup, merge to `main`, rename the local root and private GitHub repository, reset active credentials/OAuth, then start and verify Agent Core from `F:\Projects\Agent-Core`.

**Tech Stack:** TypeScript/Node.js, Vitest, MCP SDK, Windows PowerShell/batch, Git/GitHub, OpenAI Secure MCP Tunnel.

**Spec:** `docs/superpowers/specs/2026-08-23-agent-core-hard-rebrand-design.md`

## Global Constraints
- Canonical display name is `Agent Core`; machine slug and MCP server name are `agent-core`.
- Brand-specific tools are exactly `agent_core_status` and `agent_core_capabilities`; no old-name aliases remain.
- All owned environment variables use only the `AGENT_CORE_` prefix.
- All new API/OAuth credentials use only `agent_core_*` prefixes; old `cmdr_*` credentials intentionally stop working after cutover.
- Generic operational and capability tool names do not change.
- Third-party catalog/source content is never rewritten for branding.
- Port remains `8765`; OpenAI tunnel resource ID remains unless technically necessary.
- Runtime/secrets/capability caches/tunnel credentials/backups/generated plugin output remain uncommitted.
- Private GitHub history is preserved; no force history rewrite is used.

---### Task 1: Agent Core runtime and MCP identity contract

**Files:**
- Modify: `src/config.ts`, `src/index.ts`, `src/http/app.ts`, `src/mcp/server.ts`, `src/mcp/handler.ts`, `src/mcp/tools.ts`
- Modify: `tests/config.test.ts`, `tests/runtime.test.ts`, `tests/http-auth.test.ts`, `tests/mcp-integration.test.ts`, `tests/mcp-capabilities.test.ts`

**Interfaces:**
- `loadConfig()` consumes only `AGENT_CORE_HOST`, `AGENT_CORE_PORT`, `AGENT_CORE_DATA_DIR`, `AGENT_CORE_LOG_DIR`, `AGENT_CORE_CAPABILITY_DIR`, `AGENT_CORE_ALLOWED_ROOTS`.
- `createAgentCoreMcpServer()` exposes server name `agent-core`, title `Agent Core`, `agent_core_status`, and `agent_core_capabilities`.

- [ ] **Step 1: Write failing identity/config tests** asserting old `COMMANDER_*`, `desktop-commander`, `commander-mcp`, `commander_status`, and `commander_capabilities` are absent from active behavior.
- [ ] **Step 2: Run focused tests** with `npm test -- tests/config.test.ts tests/http-auth.test.ts tests/mcp-integration.test.ts tests/mcp-capabilities.test.ts`; expect RED on the old identity.
- [ ] **Step 3: Rename runtime symbols and service identity** to `AgentCoreService`, `startAgentCoreService`, `createAgentCoreMcpServer`, `agent-core`, and the two `agent_core_*` identity tools.
- [ ] **Step 4: Rename environment parsing** to `AGENT_CORE_*` only and update user-visible runtime/tool descriptions to Agent Core.
- [ ] **Step 5: Re-run focused tests + `npm run build`**; expect GREEN and the same 15 operational + 6 capability tools plus 2 Agent Core identity tools.
- [ ] **Step 6: Commit** with `feat: rebrand runtime identity to Agent Core`.

### Task 2: Credential, CLI, and OAuth hard identity

**Files:**
- Modify: `src/auth/key-store.ts`, `src/cli.ts`, `src/oauth/store.ts`, `src/oauth/service.ts`
- Modify: `tests/key-store.test.ts`, `tests/cli.test.ts`, `tests/oauth.test.ts`

**Interfaces:**
- API keys start with `agent_core_live_`.
- OAuth artifacts start with `agent_core_client_`, `agent_core_secret_`, `agent_core_code_`, `agent_core_oauth_`, and `agent_core_refresh_`.
- CLI usage name is `agent-core`; old `cmdr_*` material is rejected by new verification code.

- [ ] **Step 1: Write failing prefix tests** for all six Agent Core credential classes and explicit rejection of representative old `cmdr_*` values.
- [ ] **Step 2: Run `npm test -- tests/key-store.test.ts tests/cli.test.ts tests/oauth.test.ts`** and verify RED.
- [ ] **Step 3: Replace key/OAuth prefixes and user-facing errors/UI**; authorization HTML must say `Agent Core` and `Agent Core API key`.
- [ ] **Step 4: Rename CLI usage and descriptions** from `commander-mcp` to `agent-core` without printing raw credentials in list operations.
- [ ] **Step 5: Re-run focused tests + build**; expect GREEN.
- [ ] **Step 6: Commit** with `feat: hard rename Agent Core credentials and oauth`.### Task 3: Plugin/package/router and tracked path rename

**Files:**
- Rename: `Start-Commander-MCP.bat` -> `Start-Agent-Core.bat`
- Rename: `plugin/commander/` -> `plugin/agent-core/`
- Rename: `plugin/agent-core/skills/commander-capability-router/` -> `plugin/agent-core/skills/agent-core-capability-router/`
- Modify: `src/plugin/package-builder.ts`, `scripts/build-plugin-package.mjs`, `scripts/sync-capabilities.mjs`, `scripts/smoke-test.mjs`, `package.json`, `package-lock.json`, `.env.example`, `.gitignore`
- Modify: `tests/plugin-package.test.ts`

**Interfaces:**
- Package builder API is `buildAgentCorePluginPackage(options): Promise<AgentCorePluginBuildResult>`.
- Generated inventory is `agent-core-package.json`; package name is `Agent Core`; router skill name is `agent-core-capability-router`.

- [ ] **Step 1: Write failing package tests** asserting Agent Core package/router/app metadata and asserting old package/router names are absent.
- [ ] **Step 2: Run `npm test -- tests/plugin-package.test.ts`** and verify RED.
- [ ] **Step 3: Use `git mv` for tracked launcher/plugin paths** and rename package-builder TypeScript symbols.
- [ ] **Step 4: Update launcher/scripts/package metadata** to `AGENT_CORE_*`, `agent-core`, `Start-Agent-Core.bat`, `plugin/agent-core/generated`, and `agent-core-package.json`.
- [ ] **Step 5: Update router skill** so its frontmatter/name/title/workflow say Agent Core and call the same generic capability/operational tools.
- [ ] **Step 6: Run package test, `npm run build`, and `npm run build:plugin`**; expect GREEN.
- [ ] **Step 7: Commit** with `feat: rebrand plugin packaging to Agent Core`.

### Task 4: Documentation/file-name sweep and zero-legacy tracked scan

**Files:**
- Rename tracked historical plan/spec files containing `commander-*` to equivalent `agent-core-*` names.
- Modify: `README.md`, all owned docs/specs/plans/tests/examples containing old brand strings.
- Create: `scripts/check-agent-core-brand.mjs`
- Test: `tests/brand-sweep.test.ts`

**Interfaces:**
- `npm run check:brand` scans tracked files only, skips third-party/runtime/generated/cache content, and exits nonzero for active owned legacy strings.
- The scanner allows only the explicit migration-history explanation in `2026-08-23-agent-core-hard-rebrand-design.md`.

- [ ] **Step 1: Write failing brand-sweep test** that invokes the scanner against a fixture containing `Desktop Commander`, `COMMANDER_`, `commander-mcp`, `commander_`, `commander-`, or `cmdr_` and expects rejection.
- [ ] **Step 2: Run `npm test -- tests/brand-sweep.test.ts`** and verify RED because the scanner does not exist.
- [ ] **Step 3: Implement tracked-file scanner** using `git ls-files`, UTF-8 text inspection, explicit exclusions, and clear `path:line:match` diagnostics without reading ignored secrets/runtime data.
- [ ] **Step 4: Rename historical tracked filenames with `git mv` and update internal links/references**; preserve Git history rather than rewriting commits.
- [ ] **Step 5: Sweep owned source/tests/docs text to Agent Core** while leaving `capabilities/sources` untouched.
- [ ] **Step 6: Run `npm run check:brand`, full `npm test`, build, and plugin build**; expect zero active legacy occurrences and GREEN suite.
- [ ] **Step 7: Commit** with `docs: complete Agent Core identity sweep`.### Task 5: Cutover backup and migration utilities

**Files:**
- Create: `scripts/prepare-agent-core-cutover.ps1`
- Create: `scripts/reset-agent-core-runtime.mjs`
- Test: `tests/cutover-scripts.test.ts`

**Interfaces:**
- `prepare-agent-core-cutover.ps1` creates an untracked timestamped backup outside Git with runtime data, secrets, capability audited material, tunnel profile, current path/remote/SHA/tunnel/process metadata, and never prints secret contents.
- `reset-agent-core-runtime.mjs` starts from backed-up non-secret metadata, creates fresh Agent Core key/OAuth state in the target runtime directory, and never accepts old prefixes.

- [ ] **Step 1: Write failing cutover tests** using temp fixtures; assert backup copies expected files, excludes generated Git files, redacts metadata output, and reset produces only Agent Core prefixes.
- [ ] **Step 2: Run `npm test -- tests/cutover-scripts.test.ts`** and verify RED.
- [ ] **Step 3: Implement backup utility** with destination outside the repository and explicit manifest fields: source root, main SHA, origin URL, tunnel ID, process PID/port, copied path inventory, and timestamp.
- [ ] **Step 4: Implement runtime reset utility** to create clean `keys.json`/OAuth storage for Agent Core and write the one new production raw key only to the designated secret file with restrictive local permissions.
- [ ] **Step 5: Run focused tests and a dry-run backup against fixture paths**; expect GREEN and no secret values in console output.
- [ ] **Step 6: Commit source/tests only** with `feat: add safe Agent Core cutover tooling`.

### Task 6: Verified production cutover, repository/path rename, and final acceptance

**Files / external state:**
- Merge branch into local `main` after full verification.
- Local root: `F:\Projects\Commander-MCP` -> `F:\Projects\Agent-Core`.
- Runtime/profile: migrate owned local runtime, secrets, capabilities, and tunnel profile; `commander-mcp.yaml` -> `agent-core.yaml`.
- GitHub private repo: `rendevouz999/Desktop-Commander` -> `rendevouz999/Agent-Core` while retaining history/privacy/default `main`.

**Interfaces:**
- Production starts from `F:\Projects\Agent-Core` with `AGENT_CORE_DATA_DIR`, `AGENT_CORE_LOG_DIR`, `AGENT_CORE_CAPABILITY_DIR`, and `AGENT_CORE_ALLOWED_ROOTS`.
- `tools/list` contains exactly 23 tools with `agent_core_status` and `agent_core_capabilities`, and no old brand-specific tool names.

- [ ] **Step 1: Run pre-cutover verification in the worktree:** `npm test`, `npm run build`, `npm run build:plugin`, and `npm run check:brand`; all must pass.
- [ ] **Step 2: Execute the rollback backup utility** against the current live root and verify the backup manifest exists outside Git before stopping production.
- [ ] **Step 3: Merge verified feature branch to `main` locally and run the full suite on merged `main`**; stop if any failure occurs.
- [ ] **Step 4: Stop the live predecessor runtime, remove the feature worktree, and rename the project root** to `F:\Projects\Agent-Core` without renaming `.git` history.
- [ ] **Step 5: Rename the private GitHub repository through an authenticated GitHub repository-update mechanism**; verify visibility stays `private`, default branch stays `main`, update local `origin`, push/fetch, and compare local/remote HEAD.
- [ ] **Step 6: Run runtime reset/migration** to create a fresh `agent_core_live_...` production key and empty active OAuth clients/tokens without printing secrets; preserve the backup untouched.
- [ ] **Step 7: Rename tunnel profile to `agent-core.yaml` and update only owned local labels/config paths**; keep the same tunnel resource ID and route. Rename control-plane display name only if a supported operation is available.
- [ ] **Step 8: Start Agent Core production** from the new root and run direct authenticated acceptance: health 200, 23 tools, server `agent-core`/`Agent Core`, coverage 415, recommendation works, one audited `skill_load` works, tunnel ready 200.
- [ ] **Step 9: Run final filesystem/Git/security gates:** full tests/build/plugin build/brand scan from `F:\Projects\Agent-Core`; no tracked secrets/runtime/cache/generated output; old root not active; local `main == origin/main`.
- [ ] **Step 10: Keep rollback backup** until the user successfully reconnects/refreshes ChatGPT under Agent Core and confirms live use.

## Plan Self-Review
- Spec coverage: runtime/MCP, credentials/OAuth, env/CLI, package/router, tracked docs/file names, zero-legacy scan, backup, local path, private GitHub rename, tunnel profile, fresh credentials, live acceptance, and rollback all have explicit tasks.
- Placeholder scan: no TBD/TODO/implicit implementation steps remain.
- Type consistency: `AgentCoreService`, `startAgentCoreService`, `createAgentCoreMcpServer`, `buildAgentCorePluginPackage`, `agent_core_status`, `agent_core_capabilities`, `AGENT_CORE_*`, and all `agent_core_*` credential prefixes are used consistently.
- Safety: current `main` stays live until verified cutover; third-party content and Git history are not rewritten; raw secrets are never surfaced.
