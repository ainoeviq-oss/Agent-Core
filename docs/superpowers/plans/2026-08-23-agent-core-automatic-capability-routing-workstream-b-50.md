# Agent Core Automatic Capability Routing — Workstream B (50%)

> **Ownership:** This file contains the 50% implementation scope that the current ChatGPT session MUST NOT implement.
> It is intended for the user or another agent working in a separate Git branch/worktree.

**Source plan:** `docs/superpowers/plans/2026-08-23-agent-core-automatic-capability-routing.md`

**Source design:** `docs/superpowers/plans/2026-08-23-agent-core-automatic-capability-routing-design.md`

**Workstream split:**
- Workstream A / current ChatGPT: original Tasks 1, 2, 3, and 6 = 27 steps.
- Workstream B / this handoff: original Tasks 4, 5, and 7 = 28 steps.
- Approximate split by implementation steps: A 49.1%, B 50.9%.

## Non-Interference Contract

Workstream B MUST use its own branch and worktree. Recommended names:

```text
branch: feature/automatic-capability-routing-workstream-b
worktree: F:\Projects\Agent-Core\.worktrees\automatic-routing-b
```

Do not implement directly on production `main`.
Do not modify Workstream A-owned files until the explicit dependency checkpoint described below exists.
### Workstream A-owned files — DO NOT TOUCH in Workstream B

```text
src/capabilities/route-types.ts
src/capabilities/router.ts
src/capabilities/registry-service.ts
src/runtime/route-context-store.ts
src/runtime/services.ts
src/mcp/capability-tools.ts
src/logging/audit-log.ts
tests/capability-router.test.ts
tests/route-context-store.test.ts
tests/mcp-routing.test.ts
tests/mcp-capabilities.test.ts
tests/routing-audit.test.ts
```

`src/mcp/server.ts` is initially Workstream A-owned because Task 3 changes the public capability surface and version.
Ownership of `src/mcp/server.ts` transfers to Workstream B only after Workstream A publishes its core checkpoint commit.

## Frozen Cross-Workstream Contract

Workstream B must code against these names exactly:

```ts
capability_route
routeContextId
RouteContextStore.validate(routeContextId, principalId, toolName)
```
```ts
AgentCoreRouteError
SERVER_VERSION = '0.5.0'
stage = 'v4-automatic-capability-routing'
```

Required route error codes:

```text
ROUTE_NOT_FOUND
ROUTE_EXPIRED
ROUTE_PRINCIPAL_MISMATCH
ROUTE_TOOL_NOT_ALLOWED
ROUTE_SKILL_REQUIRED
```

Public capability surface after Workstream A checkpoint:

```text
capability_route
capability_search
capability_get
skill_load
capability_dependencies
capability_coverage
```

Public MCP tool total must remain exactly **23**.

---

# Phase B1 — Can Start Immediately
## B1 — Upgrade Native Router Skill and Plugin Package

This phase is independent enough to begin before Workstream A finishes because the public contract above is frozen.
Do not alter runtime TypeScript files in this phase.

**Owned files:**

```text
plugin/agent-core/skills/agent-core-capability-router/SKILL.md
plugin/agent-core/README.md
README.md
tests/plugin-package.test.ts
```

**Target invisible workflow:**

```text
normal user brief
→ capability_route(task, context)
→ optional skill_load(id, routeContextId)
→ route-required Agent Core tools using the same routeContextId
→ verification from route policy
```

- [ ] **B1.1 — Write/extend failing plugin test.**
Assert the packaged Router Skill contains `capability_route`, `routeContextId`, and route-aware `skill_load`.
Assert it never tells the user to explicitly name routing primitives.

- [ ] **B1.2 — Run `npm test -- tests/plugin-package.test.ts`.**
Verify RED before editing the Router Skill.
- [ ] **B1.3 — Update Router Skill preflight.**
The skill must call `capability_route` before every route-required Agent Core operation, without asking the user to mention capability tools.

- [ ] **B1.4 — Route reuse rule.**
Reuse one `routeContextId` for one coherent user goal. Create a new route only when the goal materially changes.

- [ ] **B1.5 — Required skill rule.**
Only a selected audited `native_ready` skill may be loaded with `skill_load(id, routeContextId)`.
Reference-only/catalog-only/quarantined/unresolved/unknown-license material must never be full-instruction-loaded.

- [ ] **B1.6 — Context discipline.**
Keep routing chatter internal unless risk, dependency, or routing failure materially benefits the user.

- [ ] **B1.7 — Update docs.**
Document Agent Core v0.5 automatic routing and the required one-time ChatGPT **Scan Tools / Refresh Tools + Router Skill update** after deployment.

- [ ] **B1.8 — Verify and commit.**
Run:

```powershell
npm test -- tests/plugin-package.test.ts
npm run build:plugin
```

Commit suggestion:

```text
docs: make Agent Core routing a native reflex
```

---

# Phase B2 — Start Only After Workstream A Core Checkpoint
## B2 Dependency Gate

Do not start B2 until Workstream A has published a verified core checkpoint containing original Tasks 1, 2, and 3.
That checkpoint must provide `CapabilityRouter`, `RouteContextStore`, `capability_route`, route-aware `skill_load`, `AgentCoreRouteError`, and server version `0.5.0`.

Before B2 implementation, update the Workstream B branch from that checkpoint. Do not independently recreate those classes or APIs.

After the checkpoint is integrated, ownership of `src/mcp/server.ts` transfers to Workstream B only for wiring the operational-tool principal argument.

## B2 — Hard Route Gate on Task-Execution Tools

**Owned files after dependency gate:**

```text
src/mcp/route-guard.ts
src/mcp/tools.ts
src/mcp/server.ts
tests/mcp-route-enforcement.test.ts
tests/mcp-toolset.test.ts
tests/filesystem-tools.test.ts
tests/search-tools.test.ts
tests/process-tools.test.ts
```

`registerOperationalTools` target signature:

```ts
registerOperationalTools(
  server: McpServer,
  runtime: RuntimeServices,
  key: VerifiedKey,
): void
```
Exactly these 11 tools require `routeContextId: z.string().uuid()`:

```text
list_directory
read_file
read_multiple_files
write_file
edit_file
create_directory
move_file
get_file_info
search_files
execute_command
start_process
```

These remain direct for bootstrap/recovery:

```text
agent_core_status
agent_core_capabilities
workspace_info
all capability tools
read_process_output
stop_process
list_processes
```

- [ ] **B2.1 — Write failing bypass tests for all 11 gated tools.**
A fabricated UUID must produce `ROUTE_NOT_FOUND` and the underlying filesystem/search/process operation must not execute.

- [ ] **B2.2 — Write two-principal isolation test.**
A route created by principal A must not drive `write_file` under principal B; expect `ROUTE_PRINCIPAL_MISMATCH` and no mutation.
- [ ] **B2.3 — Write required-skill enforcement test.**
When a route requires one native-ready skill, route-bound execution must return `ROUTE_SKILL_REQUIRED` before loading. After `skill_load(id, routeContextId)` succeeds, the same operation must succeed.

- [ ] **B2.4 — Implement `src/mcp/route-guard.ts`.**
Validate the route before calling filesystem/search/process services. Convert `AgentCoreRouteError` into structured MCP tool errors without swallowing the stable route error code.

- [ ] **B2.5 — Add `routeContextId` to the 11 tool schemas.**
Every gated tool description must state:

```text
Obtain routeContextId from capability_route before using this tool.
```

- [ ] **B2.6 — Preserve recovery behavior.**
An expired/missing route must never prevent `stop_process` from stopping an already-running Agent Core process session.

- [ ] **B2.7 — Update operational tests.**
Each coherent test workflow must create and reuse a legitimate route instead of fabricating one.

- [ ] **B2.8 — Run regression suite.**
Run operational, enforcement, workspace-boundary, blocked-command, OAuth/auth, and TypeScript build tests.

- [ ] **B2.9 — Commit.**
Suggested commit:

```text
feat: enforce capability routing before execution
```

---

# Phase B3 — End-to-End Acceptance / Cutover
## B3 Dependency Gate

Do not run production cutover while either workstream is incomplete.
B3 begins only after Workstream A + Workstream B changes are combined in an isolated integration worktree and all focused tests pass.

**Owned files:**

```text
scripts/smoke-test.mjs
tests/mcp-integration.test.ts
```

Production/app state is touched only after explicit user approval.

**Acceptance contract:**

```text
23 public MCP tools
capability_route present
public capability_recommend absent
11 operational tools enforce route context
capability coverage preserved
native-ready audit gate preserved
OAuth/workspace/process safety preserved
```

- [ ] **B3.1 — Extend smoke test for atomic flow.**
Route `Create a small proof file`, then route-bound `write_file`, then route-bound `read_file` using the same route ID. Assert mode `atomic_direct` and no required skill.

- [ ] **B3.2 — Add real-registry domain flow.**
Route `Improve a frontend dashboard visual hierarchy and spacing`. Assert frontend-relevant recommendation. If a native-ready skill is required, load it with the same route ID before a harmless route-bound operation.
- [ ] **B3.3 — Add bypass smoke.**
A random route UUID must be rejected and must cause no filesystem or process side effect.

- [ ] **B3.4 — Run pre-release verification in an isolated integration worktree.**
Required checks: full tests, TypeScript build, plugin package build, brand scan, and non-production smoke test.

- [ ] **B3.5 — Review the intended schema diff.**
Verify exactly one capability-tool rename (`capability_recommend` to `capability_route`), exactly 11 operational schemas gaining `routeContextId`, and no unrelated public tool or permission expansion.

- [ ] **B3.6 — Stop at the release gate.**
Present the combined Workstream A + B verification results to the user and wait for explicit approval before any production release action.
- [ ] **B3.7 — After explicit approval, release the verified integration candidate as Agent Core v0.5.0.**
Keep the last verified v0.4.0 state available for rollback until live acceptance finishes.

- [ ] **B3.8 — Refresh the ChatGPT Agent Core tool snapshot and Router Skill once.**
The refreshed app must expose 23 tools with `capability_route` and the updated route-bound operational schemas.

- [ ] **B3.9 — Fresh-chat complex test with no routing jargon.**
Use a normal brief such as: `@Agent Core perbaiki struktur dan kualitas frontend project ini, cek dulu projectnya lalu kerjakan dan verifikasi hasilnya.`
Success requires internal route creation, optional audited skill load, route-bound execution, and verification without explicit routing instructions from the user.

- [ ] **B3.10 — Fresh-chat atomic test with no routing jargon.**
Use: `@Agent Core buat file route-proof.txt berisi "Agent Core automatic routing works".`
Success requires an internal atomic route and route-bound write without unrelated skill loading.
- [ ] **B3.11 — Final acceptance gate.**
Confirm tunnel readiness, clean Git state, local `main` equals private `origin/main`, 23 live tools, routing enforcement active, capability coverage preserved, and no tracked runtime/secrets/generated cache.

---

# Workstream B Completion Boundary

When B1, B2, and B3 implementation work is complete, stop. Do not add capabilities outside this plan.
Do not modify the 415-capability audit/promotion pipeline, add subagents, add GUI automation, add system-administration tools, or expand permissions as part of this workstream.

Workstream B completion evidence must include:

```text
branch/worktree used
commit SHAs
files changed
focused test results
full test result
build result
plugin build result
brand scan result
schema/tool-count diff
live acceptance result only if production release was explicitly approved
```

Do not delete rollback material until the user confirms the fresh-chat Agent Core tests succeed.

# Merge Coordination Rule

Workstream B must never force-push or rewrite Workstream A history.
If a merge conflict touches a Workstream A-owned file, stop and resolve it with the Workstream A owner instead of choosing a side automatically.

The final integration must preserve the frozen contract in this file unless the user explicitly approves a design change.
