# Agent Core Toolset V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a practical, guarded Agent-Core-style filesystem, search, and process toolset to the existing authenticated MCP server.

**Architecture:** Introduce focused workspace, filesystem, search, and process services. The MCP registration layer only validates schemas, invokes these services, and formats results. Existing OAuth/API-key authentication remains unchanged.

**Tech Stack:** Node.js 24, TypeScript 7, MCP TypeScript SDK 1.30, Zod 4, Vitest 4.

**Spec:** `docs/superpowers/specs/2026-08-22-agent-core-toolset-v2-design.md`

## Global Constraints
- All filesystem and process working-directory access must stay inside `AGENT_CORE_ALLOWED_ROOTS`.
- Default root is current working directory, never unrestricted access.
- Existing-path checks must resist symlink/junction escapes.
- High-risk system/storage/privilege commands are blocked.
- No raw credentials may appear in tool results or logs.
- Every new behavior follows RED → GREEN → refactor TDD.

---
### Task 1: Workspace boundary service
**Files:** Create `src/runtime/workspace.ts`; modify `src/config.ts`; test `tests/workspace.test.ts` and `tests/config.test.ts`.

**Interfaces:** `WorkspacePolicy` exposes `roots`, `resolveExisting(path)`, `resolveTarget(path)`, and `isAllowed(path)`.

- [ ] Write failing tests for multi-root parsing, default-root behavior, allowed paths, traversal rejection, and existing-path realpath enforcement.
- [ ] Run focused tests and confirm failure because workspace support does not exist.
- [ ] Implement minimal config parsing and `WorkspacePolicy`.
- [ ] Run focused and full tests; commit when green.

### Task 2: Filesystem and search services
**Files:** Create `src/runtime/filesystem.ts`, `src/runtime/search.ts`; test `tests/filesystem-tools.test.ts`, `tests/search-tools.test.ts`.

**Interfaces:** Filesystem service returns JSON-safe metadata/list/read/write/edit/move results. Search service accepts `{query, path, mode, maxResults}` and returns bounded matches.

- [ ] Write failing tests for list/read/multi-read/write/append/edit/mkdir/move/info and denied outside-root access.
- [ ] Verify RED, implement minimal filesystem service, verify GREEN.
- [ ] Write failing filename/content search tests including result limits and outside-root rejection.
- [ ] Implement search service and run focused/full tests; commit when green.
### Task 3: Process execution and sessions
**Files:** Create `src/runtime/process-manager.ts`; test `tests/process-tools.test.ts`.

**Interfaces:** `ProcessManager.execute`, `start`, `read`, `stop`, and `list` use opaque Agent Core session IDs and bounded captured output.

- [ ] Write failing tests for successful one-shot execution, blocked commands, timeout, background start/read/stop, and working-directory boundary enforcement.
- [ ] Verify RED and implement the smallest Windows PowerShell-backed process manager.
- [ ] Run focused/full tests; commit when green.

### Task 4: MCP registration and acceptance
**Files:** Create `src/mcp/tools.ts`; modify `src/mcp/server.ts`, `src/mcp/handler.ts`, `src/index.ts`; modify `tests/mcp-integration.test.ts`; add `tests/mcp-toolset.test.ts`.

**Interfaces:** `createAgentCoreMcpServer(key, runtime)` receives workspace/filesystem/search/process services and exposes the V2 tool names defined by the spec.

- [ ] Write failing MCP tests asserting V2 tool discovery and representative read/write/search/execute calls.
- [ ] Verify RED, register schemas and handlers, and update capabilities/version metadata.
- [ ] Run all tests and TypeScript build.
- [ ] Restart production MCP and tunnel, then verify OAuth tunnel readiness and live `tools/list` through a local authenticated client.
- [ ] Commit the V2 integration after fresh verification.
