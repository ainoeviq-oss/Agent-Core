# Agent Core Automatic Capability Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Agent Core automatically route normal user briefs through its capability system before task execution, without requiring the user to mention routing tools or skill names.

**Architecture:** Reuse the existing `CapabilityRegistry` and native Router Skill, add a deterministic `CapabilityRouter` plus in-memory authenticated route-context store, replace public `capability_recommend` with `capability_route`, and require server-issued `routeContextId` values on task-execution tools. The native Skill provides the intuitive preflight; the runtime gate guarantees that execution cannot silently bypass routing.

**Tech Stack:** TypeScript 7, Node.js 24+, MCP SDK 1.30.0, Zod 4, Vitest 4, existing Agent Core OAuth/API-key principal identity and capability registry.

**Spec:** `docs/superpowers/specs/2026-08-23-agent-core-automatic-capability-routing-design.md`

## Global Constraints
- Do not add another LLM, Ollama model, autonomous subagent, or hidden reasoning service.
- Reuse `CapabilityRegistry`; do not create a second capability catalog/index.
- Keep the public MCP tool count at **23** by replacing `capability_recommend` with `capability_route`.
- Target Agent Core server version **0.5.0** and stage `v4-automatic-capability-routing`.
- Only existing `native_ready` + `nativeEligible` audited skills may be required/loaded.
- Catalog-only/reference-only/quarantined/unresolved/unknown-license material may influence compact metadata routing but never full instruction loading.
- Route contexts are in-memory only, principal-bound, expire after **30 minutes**, and are capped at **256** active contexts.
- Do not weaken workspace boundaries, process blocked-command rules, OAuth/API-key auth, ChatGPT permission controls, or existing safety behavior.
- Do not persist or log full user prompts, raw credentials, OAuth tokens, or loaded skill instruction bodies.
- Third-party source content remains untouched.

---

### Task 1: Add routing contracts and deterministic capability decision engine

**Files:**
- Create: `src/capabilities/route-types.ts`
- Create: `src/capabilities/router.ts`
- Modify: `src/capabilities/registry-service.ts`
- Test: `tests/capability-router.test.ts`

**Interfaces:**
- Consumes: existing `CapabilityRegistry.recommend(task, context, limit)` and `CapabilitySummary`.
- Produces:
```ts
export type RouteTier = 'atomic' | 'structured' | 'domain_complex' | 'high_impact';
export type RouteMode = 'atomic_direct' | 'capability_guided' | 'skill_guided';

export interface RoutePlan {
  tier: RouteTier;
  mode: RouteMode;
  domain: string;
  confidence: number;
  risk: CapabilityRisk;
  recommendedCapabilities: CapabilitySummary[];
  requiredSkillLoads: Array<{ id: string; name: string }>;
  allowedTools: string[];
  verification: { required: boolean; suggestedTools: string[] };
  reasonCodes: string[];
}

export class CapabilityRouter {
  constructor(private readonly registry: CapabilityRegistry) {}
  route(task: string, context?: string): RoutePlan;
}
```

- [ ] **Step 1: Write failing route-classification tests** using a fixture registry with one frontend `native_ready` skill, one stronger reference-only debugging capability, and one unrelated skill. Assert:
```ts
const atomic = router.route('Create notes.txt containing hello');
expect(atomic).toMatchObject({ tier: 'atomic', mode: 'atomic_direct' });
expect(atomic.requiredSkillLoads).toEqual([]);

const frontend = router.route('Refactor this frontend dashboard to improve visual hierarchy and spacing');
expect(frontend.tier).toBe('domain_complex');
expect(frontend.mode).toBe('skill_guided');
expect(frontend.requiredSkillLoads[0]?.name).toBe('frontend-quality');

const debug = router.route('Investigate and fix this multi-step backend crash');
expect(debug.recommendedCapabilities[0]?.name).toBe('backend-debug-reference');
expect(debug.requiredSkillLoads).toEqual([]);
```

- [ ] **Step 2: Run `npm test -- tests/capability-router.test.ts`** and verify RED because `CapabilityRouter` does not exist.

- [ ] **Step 3: Implement route types and deterministic scoring/classification.** Use existing recommendation scores as the primary relevance signal. Add bounded task-shape signals:
```ts
const STRUCTURED_SIGNAL = /\b(and|then|after|before|review|refactor|debug|test|design|build|implement|analy[sz]e|optimi[sz]e)\b/i;
const HIGH_IMPACT_SIGNAL = /\b(production|deploy|credential|secret|system|admin|registry|delete|remove|shutdown|format)\b/i;
```
Classify `high_impact` first, then `domain_complex` when a strong domain recommendation and structured signal coexist, then `structured`, otherwise `atomic`.

- [ ] **Step 4: Implement native-ready selection without relevance inversion.** A native-ready skill can become required only when its score is at least `Math.max(8, topScore * 0.65)`. Select at most 2 required skills; prefer fewer when one clearly covers the task.

- [ ] **Step 5: Implement verification policy.** Atomic read-like task -> optional verification; atomic mutation -> read-back verification; structured/domain/high-impact -> required. Keep suggested tools compact (`read_file`, `get_file_info`, `search_files`, process output) rather than generating a full execution plan.

- [ ] **Step 6: Run focused tests and ensure deterministic output** by calling `router.route()` twice with identical inputs and asserting deep equality.

- [ ] **Step 7: Commit** with `feat: add deterministic Agent Core capability router`.

---

### Task 2: Add authenticated in-memory route-context lifecycle

**Files:**
- Create: `src/runtime/route-context-store.ts`
- Modify: `src/runtime/services.ts`
- Test: `tests/route-context-store.test.ts`

**Interfaces:**
```ts
export interface RouteContext extends RoutePlan {
  routeContextId: string;
  principalId: string;
  loadedSkillIds: string[];
  createdAt: string;
  expiresAt: string;
}

export class RouteContextStore {
  create(principalId: string, plan: RoutePlan): RouteContext;
  get(routeContextId: string): RouteContext | null;
  markSkillLoaded(routeContextId: string, principalId: string, skillId: string): RouteContext;
  validate(routeContextId: string, principalId: string, toolName: string): RouteContext;
}
```
`RuntimeServices` gains:
```ts
router: CapabilityRouter;
routes: RouteContextStore;
```

- [ ] **Step 1: Write failing lifecycle tests** asserting UUID-shaped route IDs, 30-minute expiry, principal ownership, skill-load marking, required-skill enforcement, and 256-context pruning.

- [ ] **Step 2: Run `npm test -- tests/route-context-store.test.ts`** and verify RED.

- [ ] **Step 3: Implement `RouteContextStore` with `crypto.randomUUID()`.** Store contexts in a `Map<string, InternalRouteContext>`; never persist to disk.

- [ ] **Step 4: Implement stable validation errors** using an `AgentCoreRouteError` carrying one of:
```ts
'ROUTE_NOT_FOUND' |
'ROUTE_EXPIRED' |
'ROUTE_PRINCIPAL_MISMATCH' |
'ROUTE_TOOL_NOT_ALLOWED' |
'ROUTE_SKILL_REQUIRED'
```

- [ ] **Step 5: Implement pruning.** Before create/get/validate, delete expired contexts. When size is still >=256 before a create, remove oldest contexts until room exists.

- [ ] **Step 6: Wire router/store into `createRuntimeServices()`** using the same `CapabilityRegistry` instance already loaded for capability tools.

- [ ] **Step 7: Run focused tests and existing registry tests** to prove no duplicate registry behavior was introduced.

- [ ] **Step 8: Commit** with `feat: add principal-bound routing contexts`.

---

### Task 3: Replace recommendation MCP primitive with route creation and route-aware skill loading

**Files:**
- Modify: `src/mcp/capability-tools.ts`
- Modify: `src/mcp/server.ts`
- Test: `tests/mcp-routing.test.ts`
- Modify: `tests/mcp-capabilities.test.ts`

**Interfaces:**
Public capability tool names become:
```ts
[
  'capability_route',
  'capability_search',
  'capability_get',
  'skill_load',
  'capability_dependencies',
  'capability_coverage',
]
```

`registerCapabilityTools` changes to receive the authenticated principal:
```ts
registerCapabilityTools(server: McpServer, runtime: RuntimeServices, key: VerifiedKey): void
```

`skill_load` input becomes:
```ts
{
  id: string;
  routeContextId?: string;
}
```

- [ ] **Step 1: Write failing MCP tests** asserting `tools/list` contains `capability_route`, excludes public `capability_recommend`, and total tool count remains 23 after all tools register.

- [ ] **Step 2: Write failing route-call test**:
```ts
const routed = await call('capability_route', {
  task: 'Improve this frontend dashboard hierarchy and spacing',
});
expect(routed.routeContextId).toMatch(UUID_RE);
expect(routed.tier).toBe('domain_complex');
```

- [ ] **Step 3: Implement `capability_route`** as read-only/idempotent from the model's perspective: create `RoutePlan`, then issue a principal-bound context through `runtime.routes.create(key.id, plan)`.

- [ ] **Step 4: Extend `skill_load` route binding.** After existing audited `loadSkill(id)` succeeds, call `runtime.routes.markSkillLoaded(routeContextId, key.id, id)` when a route ID was supplied. Never mark before instruction loading succeeds.

- [ ] **Step 5: Update `agent_core_capabilities`** to version `0.5.0`, stage `v4-automatic-capability-routing`, and expose enabled markers:
```ts
'routing.capability_route',
'routing.principal_bound_context',
'routing.execution_gate'
```

- [ ] **Step 6: Run capability/MCP tests and build**; ensure capability search/get/dependencies/coverage behavior remains unchanged.

- [ ] **Step 7: Commit** with `feat: expose Agent Core capability routing`.

---

### Task 4: Enforce routing context on task-execution operational tools

**Files:**
- Create: `src/mcp/route-guard.ts`
- Modify: `src/mcp/tools.ts`
- Modify: `src/mcp/server.ts`
- Test: `tests/mcp-route-enforcement.test.ts`
- Modify: `tests/mcp-toolset.test.ts`
- Modify: `tests/filesystem-tools.test.ts`
- Modify: `tests/search-tools.test.ts`
- Modify: `tests/process-tools.test.ts`

**Interfaces:**
`registerOperationalTools` receives authenticated principal:
```ts
registerOperationalTools(server: McpServer, runtime: RuntimeServices, key: VerifiedKey): void
```

Route-required schemas gain:
```ts
routeContextId: z.string().uuid()
```
for exactly these 11 tools:
`list_directory`, `read_file`, `read_multiple_files`, `write_file`, `edit_file`, `create_directory`, `move_file`, `get_file_info`, `search_files`, `execute_command`, `start_process`.

- [ ] **Step 1: Write failing bypass tests.** Calling each route-required tool with a fabricated UUID must return `isError: true` and code `ROUTE_NOT_FOUND`; verify the underlying file/process effect did not happen.

- [ ] **Step 2: Write principal-mismatch test** using two API keys: create route with principal A, call `write_file` with principal B and A's route; expect `ROUTE_PRINCIPAL_MISMATCH` and no file mutation.

- [ ] **Step 3: Write skill-required test** using a fixture route that requires one native skill. Before `skill_load`, `write_file` returns `ROUTE_SKILL_REQUIRED`; after `skill_load(id, routeContextId)`, the same write succeeds.

- [ ] **Step 4: Implement `route-guard.ts`** to normalize route errors into structured MCP tool errors without calling filesystem/process services on failure.

- [ ] **Step 5: Add `routeContextId` to the 11 schemas and descriptions.** Each description explicitly says: `Obtain routeContextId from capability_route before using this tool.`

- [ ] **Step 6: Keep bootstrap/recovery tools direct.** Confirm `workspace_info`, `read_process_output`, `stop_process`, and `list_processes` do not acquire route fields.

- [ ] **Step 7: Update all operational tests** to create one route context through the runtime fixture and reuse it across the coherent test workflow instead of fabricating route IDs.

- [ ] **Step 8: Run full operational + enforcement tests and build.** Verify existing workspace and blocked-command safety tests still pass unchanged in meaning.

- [ ] **Step 9: Commit** with `feat: enforce capability routing before execution`.

---

### Task 5: Upgrade the native Router Skill and package contract

**Files:**
- Modify: `plugin/agent-core/skills/agent-core-capability-router/SKILL.md`
- Modify: `src/plugin/package-builder.ts` only if metadata needs the new routing release name
- Modify: `plugin/agent-core/README.md`
- Modify: `README.md`
- Modify: `tests/plugin-package.test.ts`

**Interfaces:**
The Router Skill must describe the user-invisible flow:
```text
normal user brief
→ capability_route(task, context)
→ optional skill_load(id, routeContextId)
→ route-required operational tools using same routeContextId
→ verification suggested by route
```

- [ ] **Step 1: Write/extend plugin test** that reads packaged Router Skill and asserts it contains `capability_route`, `routeContextId`, and `skill_load`, and does not instruct the user to name routing tools.

- [ ] **Step 2: Update Router Skill preflight.** It must call `capability_route` before any route-required Agent Core tool, reuse one route across one coherent goal, and create a fresh route only when the goal materially changes.

- [ ] **Step 3: Update skill-loading behavior.** Required native-ready skills use `skill_load(id, routeContextId)`; reference-only recommendations stay metadata guidance and are never loaded.

- [ ] **Step 4: Update context discipline.** Routing chatter stays internal unless risk/dependency/failure information materially benefits the user.

- [ ] **Step 5: Update README architecture diagram and operator instructions** to describe automatic routing and the one-time ChatGPT Scan Tools/Router Skill refresh required by the schema change.

- [ ] **Step 6: Run plugin package tests and `npm run build:plugin`**; expect package still contains only Router Skill plus audited native-ready skills.

- [ ] **Step 7: Commit** with `docs: make Agent Core routing a native reflex`.

---

### Task 6: Add observability without prompt/skill-content leakage

**Files:**
- Modify: `src/logging/audit-log.ts`
- Modify: routing creation/validation call sites from Tasks 2-4
- Test: `tests/routing-audit.test.ts`

**Interfaces:**
Routing audit events contain only bounded metadata:
```ts
{
  event: 'route.created' | 'route.validated' | 'route.rejected' | 'route.skill_loaded';
  routeContextId: string;
  principalId: string;
  tier?: RouteTier;
  mode?: RouteMode;
  risk?: CapabilityRisk;
  capabilityIds?: string[];
  skillIds?: string[];
  toolName?: string;
  errorCode?: string;
  timestamp: string;
}
```

- [ ] **Step 1: Write failing audit tests** that execute route/create/load/validate/reject flows and assert event metadata exists.

- [ ] **Step 2: Add sentinel secrets and task text to tests** and assert audit output does not contain raw user task/context, API key, OAuth token, or loaded SKILL.md body.

- [ ] **Step 3: Implement routing audit helpers** alongside existing request auditing; do not duplicate transport/request logs.

- [ ] **Step 4: Run audit, OAuth, and secret-leak regression tests.**

- [ ] **Step 5: Commit** with `feat: audit Agent Core routing decisions safely`.

---

### Task 7: End-to-end acceptance and production cutover to v0.5.0

**Files:**
- Modify: `scripts/smoke-test.mjs`
- Modify: `tests/mcp-integration.test.ts`
- Modify: `docs/superpowers/plans/2026-08-23-agent-core-automatic-capability-routing.md` to mark executed steps only after completion
- Runtime/app state: current Agent Core production + ChatGPT custom app tool snapshot + Router Skill

**Acceptance contract:**
- Agent Core server: `0.5.0`, stage `v4-automatic-capability-routing`.
- Public MCP tool count remains **23**.
- `capability_route` present; public `capability_recommend` absent.
- Route-required execution cannot succeed without a valid principal-bound context.
- Current capability coverage remains 415 unless an explicit catalog sync changes upstream data.
- Native-ready gating remains intact.

- [ ] **Step 1: Extend smoke test** to perform:
```text
capability_route("Create a small proof file")
→ write_file(routeContextId)
→ read_file(routeContextId)
```
and assert the route is `atomic_direct` with no skill load.

- [ ] **Step 2: Add domain-complex smoke path** against the real registry:
```text
capability_route("Improve a frontend dashboard visual hierarchy and spacing")
```
Assert a frontend-relevant recommendation appears. If a relevant native-ready skill is returned as required, call `skill_load(id, routeContextId)` before a harmless route-bound read operation.

- [ ] **Step 3: Add bypass smoke assertion** that a route-required call with a random UUID is rejected and produces no side effect.

- [ ] **Step 4: Run pre-cutover gates on isolated feature branch/worktree:** full `npm test`, `npm run build`, `npm run build:plugin`, brand scan, and live local smoke against a non-production port or temporary fixture runtime.

- [ ] **Step 5: Review tool schema diff before merge.** Confirm exactly one capability tool name changed (`capability_recommend` -> `capability_route`) and exactly 11 operational schemas gained `routeContextId`; no unrelated permissions/tools are added.

- [ ] **Step 6: Merge only after explicit user approval of implementation results.** Push private `main`, restart Agent Core production, and preserve rollback point to the last verified v0.4.0 commit.

- [ ] **Step 7: Refresh/Scan Tools once in the ChatGPT Agent Core app** so the new tool name and route-required schemas are visible.

- [ ] **Step 8: Update/install the Agent Core Capability Router Skill** from the generated plugin package.

- [ ] **Step 9: Fresh-chat automatic test with no routing jargon.** User prompt example:
```text
@Agent Core perbaiki struktur dan kualitas frontend project ini, cek dulu projectnya lalu kerjakan dan verifikasi hasilnya.
```
Success requires observed internal sequence equivalent to:
```text
capability_route
→ optional skill_load
→ read/search/edit/execute using one routeContextId
→ verification
```
The user must not have to mention `capability_route`, `routeContextId`, or any skill name.

- [ ] **Step 10: Fresh-chat atomic test with no routing jargon.** Example:
```text
@Agent Core buat file route-proof.txt berisi "Agent Core automatic routing works".
```
Success requires `capability_route` -> `atomic_direct` -> `write_file` under the issued route; no unrelated skill load.

- [ ] **Step 11: Final verification:** tunnel readiness 200, Git clean, local `main == origin/main`, 23 live tools, route enforcement active, 415 coverage preserved, and no tracked runtime/secrets/generated capability cache.

---

## Review Decisions to Adjust Before Approval
These are deliberate defaults, not unresolved implementation placeholders. Change them in this plan before execution if desired:

1. **Enforcement breadth:** current plan routes 11 task-execution tools, including reads/search. This maximizes automatic behavior. A lighter variant could hard-gate only mutation/process tools, but complex read-only analysis could then bypass the capability system if the native Skill is not selected.
2. **Route TTL:** current plan uses 30 minutes. Longer improves long workflows; shorter reduces stale-route reuse.
3. **Required native skill limit:** current plan allows at most 2 required skills per route to protect context discipline.
4. **Public surface:** current plan replaces `capability_recommend` with `capability_route` and keeps 23 tools. Keeping both temporarily would make 24 tools and introduce a compatibility phase.
5. **Verification:** current plan guides verification but does not add a mandatory `route_complete` tool. A hard completion lifecycle can be a later independent project after observing real routing behavior.

## Plan Self-Review
- **No duplicated subsystem:** `CapabilityRegistry.recommend/search/loadSkill` remains the single registry implementation; routing wraps it.
- **Hard automation path exists:** required `routeContextId` plus principal-bound validation prevents silent operational bypass.
- **Soft intuition path exists:** Router Skill makes normal prompts naturally call `capability_route` before the schema gate has to reject anything.
- **Safety preserved:** existing workspace/process/permission controls remain independent and authoritative.
- **Context discipline preserved:** only selected audited native-ready skills load full instructions.
- **Current bottleneck acknowledged:** this plan does not pretend 415 catalog records are 415 executable skills; native-ready expansion stays separate.
- **Rollback is clear:** production remains on current v0.4.0 until all feature-branch verification passes and implementation results are explicitly approved.
