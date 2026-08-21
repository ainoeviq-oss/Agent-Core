# Commander MCP V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a locally hosted Streamable HTTP MCP gateway with custom bearer API-key authentication, key lifecycle CLI, two discovery tools, audit logging, and verified Windows startup.

**Architecture:** A small Node HTTP application authenticates every `/mcp` request against a file-backed salted-scrypt key store, then hands valid requests to the official MCP Streamable HTTP transport. MCP server construction, key storage, HTTP routing, CLI key administration, and audit logging remain isolated modules with explicit interfaces.

**Tech Stack:** Node.js 24, TypeScript 7, `@modelcontextprotocol/sdk` 1.30.0, Zod 4.4.3, Vitest 4.1.11, native Node crypto/fs/http.

**Spec:** `docs/superpowers/specs/2026-08-22-commander-mcp-v1-design.md`

## Global Constraints
- All project source, generated data, logs, and scripts live under `F:\Projects\Commander-MCP`.
- Default bind is `127.0.0.1:8765`.
- Raw API keys are never persisted or logged.
- Key prefix is `cmdr_live_`.
- `/health` is unauthenticated; `/mcp` requires bearer authentication on every request.
- V1 exposes only `commander_status` and `commander_capabilities`.
- Filesystem, shell, process, Git, OAuth, and tunnel features are deferred.

---

### Task 1: Project Baseline and Build Configuration
**Files:** `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`, `src/config.ts`, `tests/config.test.ts`
**Produces:** `loadConfig(env): AppConfig` with host, port, dataDir, logDir.
- [ ] Write `tests/config.test.ts` asserting defaults `127.0.0.1`, `8765`, and project-local `data`/`logs` paths.
- [ ] Run `npm test -- tests/config.test.ts` and verify RED because `loadConfig` does not exist.
- [ ] Implement the minimal `src/config.ts` parser and directory normalization.
- [ ] Run the focused test and the full suite; verify GREEN.
- [ ] Commit `chore: establish commander mcp project baseline`.

### Task 2: Secure API-Key Store
**Files:** `src/auth/key-store.ts`, `src/auth/key-types.ts`, `tests/key-store.test.ts`
**Produces:** `FileKeyStore.create`, `.verify`, `.list`, `.revoke`, `.rotate`; `VerifiedKey` identity.
- [ ] Write tests proving generated prefix, no raw-key persistence, valid verification, invalid rejection, revoke, and rotation semantics.
- [ ] Run `npm test -- tests/key-store.test.ts`; verify RED because key-store symbols are missing.
- [ ] Implement minimal JSON persistence with random salt, Node `scrypt`, and `timingSafeEqual`.
- [ ] Run focused tests, then full suite; verify GREEN.
- [ ] Commit `feat: add secure api key lifecycle`.

### Task 3: HTTP Authentication and Audit Logging
**Files:** `src/http/auth.ts`, `src/logging/audit-log.ts`, `src/http/app.ts`, `tests/http-auth.test.ts`
**Consumes:** `FileKeyStore.verify` and `VerifiedKey`.
**Produces:** HTTP request handler with `GET /health` and authenticated `/mcp` delegation hook.
- [ ] Write HTTP tests for health 200, missing bearer 401, malformed bearer 401, invalid key 401, valid key reaching a test delegation hook, and log redaction.
- [ ] Run `npm test -- tests/http-auth.test.ts`; verify RED.
- [ ] Implement bearer parsing, per-request verification, health payload, request ids, duration/status audit records, and token redaction.
- [ ] Run focused tests and full suite; verify GREEN.
- [ ] Commit `feat: protect mcp http endpoint with bearer keys`.

### Task 4: MCP Server and Streamable HTTP Transport
**Files:** `src/mcp/server.ts`, `src/mcp/handler.ts`, `tests/mcp-integration.test.ts`
**Consumes:** authenticated `VerifiedKey` and HTTP delegation hook.
**Produces:** MCP initialize, tools/list, and tools/call over Streamable HTTP.
- [ ] Write an integration test that creates a real generated key and sends MCP JSON-RPC requests through the HTTP application.
- [ ] Assert initialize returns the `desktop-commander` identity; tools/list returns exactly the two V1 tools; tools/call returns structured status/capability data including authenticated key identity.
- [ ] Run `npm test -- tests/mcp-integration.test.ts`; verify RED.
- [ ] Implement MCP server construction and Streamable HTTP request handling with official SDK types and transports.
- [ ] Run focused tests and full suite; verify GREEN.
- [ ] Commit `feat: expose authenticated streamable http mcp`.

### Task 5: Key Administration CLI
**Files:** `src/cli.ts`, `tests/cli.test.ts`
**Consumes:** `FileKeyStore` lifecycle methods.
**Produces:** `create-key`, `list-keys`, `revoke-key`, and `rotate-key` commands.
- [ ] Write CLI tests against a temporary data directory, including raw key output only on create/rotate and revoked-state listing.
- [ ] Run `npm test -- tests/cli.test.ts`; verify RED.
- [ ] Implement minimal CLI parsing, nonzero exit codes for bad input, and JSON-safe metadata output.
- [ ] Run focused tests and full suite; verify GREEN.
- [ ] Commit `feat: add commander api key cli`.

### Task 6: Production Entry Point and Windows Startup
**Files:** `src/index.ts`, `Start-Commander-MCP.bat`, `README.md`, `tests/shutdown.test.ts`
**Produces:** compiled service startup, graceful SIGINT/SIGTERM shutdown, and one-click Windows launcher.
- [ ] Write shutdown/startup tests proving listener close and port-conflict failure behavior.
- [ ] Run focused tests; verify RED.
- [ ] Implement the entry point, startup directory creation, graceful transport/listener close, BAT launcher, and concise README usage.
- [ ] Run focused tests and full suite; verify GREEN.
- [ ] Run `npm run build`; verify exit 0.
- [ ] Commit `feat: add production startup and shutdown`.

### Task 7: Live Acceptance Smoke Test
**Files:** `scripts/smoke-test.mjs`, generated `data/keys.json`, generated `logs/audit.jsonl`
**Consumes:** compiled server and CLI.
**Produces:** evidence for all V1 acceptance gates.
- [ ] Create a temporary live API key using the compiled CLI.
- [ ] Start the compiled server on `127.0.0.1:8765` and capture its PID.
- [ ] Run smoke requests proving health 200, unauthorized 401, valid MCP initialize, tools/list, both tools/call results, then revoke the key and prove 401.
- [ ] Stop the server gracefully and confirm the port is released.
- [ ] Run fresh `npm test` and `npm run build` after the smoke test.
- [ ] Inspect Git status, key database, and audit logs to verify no raw key appears in tracked files or logs.
- [ ] Commit `test: add live commander mcp acceptance probe`.

## Plan Self-Review
- Spec coverage: every V1 design acceptance condition maps to Tasks 1-7.
- No production mutation tools are introduced in V1.
- Auth checks occur at HTTP request time, not only during MCP initialization.
- Tests establish RED before each production feature implementation.
- Final completion requires fresh full tests, build, live smoke evidence, and repository inspection.