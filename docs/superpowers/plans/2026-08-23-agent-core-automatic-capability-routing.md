# Agent Core Automatic Capability Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make Agent Core automatically route normal user briefs through its capability system before execution, without requiring the user to mention routing tools, route IDs, or skill names.

**Architecture:** Reuse the existing `CapabilityRegistry` and native Router Skill, add a deterministic `CapabilityRouter` plus an in-memory authenticated route-context store, replace public `capability_recommend` with `capability_route`, and require server-issued `routeContextId` values on task-execution tools. The native Skill provides the intuitive preflight; the runtime gate guarantees that execution cannot silently bypass routing.

**Tech Stack:** TypeScript 7, Node.js 24+, MCP SDK 1.30.0, Zod 4, Vitest 4, existing Agent Core OAuth/API-key principal identity and capability registry.

**Spec:** `docs/superpowers/plans/2026-08-23-agent-core-automatic-capability-routing-design.md`

## Global Constraints
- Do not add another LLM, Ollama model, autonomous subagent, or hidden reasoning service.
- Reuse `CapabilityRegistry`; do not create a second capability catalog/index.
- Keep the public MCP tool count at **23** by replacing `capability_recommend` with `capability_route`.
- Target Agent Core server version **0.5.0** and stage `v4-automatic-capability-routing`.
- Only existing `native_ready` + `nativeEligible` audited skills may be required/loaded.
- Catalog-only/reference-only/quarantined/unresolved/unknown-license material may influence compact routing metadata but never full instruction loading.
- Route contexts are in-memory only, principal-bound, expire after **30 minutes**, and are capped at **256** active contexts.
- Do not weaken workspace boundaries, blocked-command logic, OAuth/API-key auth, ChatGPT permission controls, or existing safety behavior.
- Do not persist or log full user prompts, raw credentials, OAuth tokens, or loaded skill instruction bodies.
- Third-party source content remains untouched.

---

### Task 1: Routing contracts and deterministic capability decision engine

**Files:**
- Create: `src/capabilities/route-types.ts`
- Create: `src/capabilities/router.ts`
- Modify: `src/capabilities/registry-service.ts`
- Test: `tests/capability-router.test.ts`

**Interfaces:**
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

- [x] **Step 1: Write failing route-classification tests** with a fixture registry containing one frontend `native_ready` skill, one strongly relevant reference-only debugging capability, and one unrelated skill. Assert atomic work becomes `atomic_direct`, frontend work becomes `domain_complex` + `skill_guided`, and reference-only recommendations never become required skill loads.

```ts
expect(router.route('Create notes.txt containing hello')).toMatchObject({
  tier: 'atomic', mode: 'atomic_direct', requiredSkillLoads: [],
});
expect(router.route('Refactor this frontend dashboard to improve visual hierarchy and spacing')).toMatchObject({
  tier: 'domain_complex', mode: 'skill_guided',
});
```

- [x] **Step 2: Run `npm test -- tests/capability-router.test.ts`** and verify RED because `CapabilityRouter` does not exist.

- [x] **Step 3: Implement deterministic classification** using existing recommendation scores as the primary relevance signal plus bounded task-shape signals:
```ts
const STRUCTURED_SIGNAL = /\b(and|then|after|before|review|refactor|debug|test|design|build|implement|analy[sz]e|optimi[sz]e)\b/i;
const HIGH_IMPACT_SIGNAL = /\b(production|deploy|credential|secret|system|admin|registry|delete|remove|shutdown|format)\b/i;
```
Priority: `high_impact` -> strong-domain+structured -> `domain_complex` -> structured -> `structured` -> otherwise `atomic`.

- [x] **Step 4: Implement native-ready selection without relevance inversion.** A native-ready skill can become required only when score >= `Math.max(8, topScore * 0.65)`. Select at most 2 required skills.

- [x] **Step 5: Implement verification policy.** Atomic read-like route may skip verification; atomic mutation gets cheap read-back; structured/domain/high-impact requires verification.

- [x] **Step 6: Assert determinism** by deep-comparing repeated routing output for identical registry/task/context inputs.

- [x] **Step 7: Commit** `feat: add deterministic Agent Core capability router`.

---

### Task 2: Principal-bound in-memory route contexts

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

`RuntimeServices` gains `router: CapabilityRouter` and `routes: RouteContextStore`, both using the already-open `CapabilityRegistry`.

- [x] **Step 1: Write failing lifecycle tests** for UUID route IDs, 30-minute expiry, principal ownership, loaded-skill state, required-skill enforcement, and 256-context pruning.
- [x] **Step 2: Run `npm test -- tests/route-context-store.test.ts`** and verify RED.
- [x] **Step 3: Implement storage with `crypto.randomUUID()` and `Map`**, never disk persistence.
- [x] **Step 4: Implement stable `AgentCoreRouteError` codes:** `ROUTE_NOT_FOUND`, `ROUTE_EXPIRED`, `ROUTE_PRINCIPAL_MISMATCH`, `ROUTE_TOOL_NOT_ALLOWED`, `ROUTE_SKILL_REQUIRED`.
- [x] **Step 5: Prune expired contexts opportunistically; when still >=256 before create, prune oldest until capacity exists.**
- [x] **Step 6: Wire router/store into `createRuntimeServices()`** with the same registry instance.
- [x] **Step 7: Run route-context + registry regression tests.**
- [x] **Step 8: Commit** `feat: add principal-bound routing contexts`.

---

### Task 3: Replace public recommendation with `capability_route`

**Files:**
- Modify: `src/mcp/capability-tools.ts`
- Modify: `src/mcp/server.ts`
- Test: `tests/mcp-routing.test.ts`
- Modify: `tests/mcp-capabilities.test.ts`

**Public capability tool names:**
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

`registerCapabilityTools(server, runtime, key)` receives the authenticated `VerifiedKey`.

- [x] **Step 1: Write failing tool-surface tests**: `capability_route` exists, public `capability_recommend` is absent, total tools remain 23.
- [x] **Step 2: Write failing route-call test** and assert returned UUID/tier/mode/recommendations.
- [x] **Step 3: Implement `capability_route` as a non-destructive but non-idempotent internal-state action.** MCP annotations must be `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`, `openWorldHint: false`, because each call issues a fresh route context.
- [x] **Step 4: Extend `skill_load` input** to `{ id, routeContextId?: string }`. Existing audited loading happens first; only after success does `runtime.routes.markSkillLoaded(routeContextId, key.id, id)` run.
- [x] **Step 5: Bump server to `0.5.0` and stage `v4-automatic-capability-routing`**, adding capability markers `routing.capability_route`, `routing.principal_bound_context`, `routing.execution_gate`.
- [x] **Step 6: Run capability/MCP tests and TypeScript build.**
- [x] **Step 7: Commit** `feat: expose Agent Core capability routing`.

---

### Task 4: Hard route gate on task-execution tools

**Files:**
- Create: `src/mcp/route-guard.ts`
- Modify: `src/mcp/tools.ts`
- Modify: `src/mcp/server.ts`
- Test: `tests/mcp-route-enforcement.test.ts`
- Modify: `tests/mcp-toolset.test.ts`
- Modify: `tests/filesystem-tools.test.ts`
- Modify: `tests/search-tools.test.ts`
- Modify: `tests/process-tools.test.ts`

`registerOperationalTools(server, runtime, key)` receives the authenticated principal.

Exactly these 11 tools gain required `routeContextId: z.string().uuid()`:
`list_directory`, `read_file`, `read_multiple_files`, `write_file`, `edit_file`, `create_directory`, `move_file`, `get_file_info`, `search_files`, `execute_command`, `start_process`.

The following remain direct for identity/bootstrap/capability/recovery: `agent_core_status`, `agent_core_capabilities`, `workspace_info`, all capability tools, `read_process_output`, `stop_process`, `list_processes`.

- [x] **Step 1: Write failing bypass tests** for all 11 tools using a fabricated UUID; expect `ROUTE_NOT_FOUND` and zero underlying side effect.
- [x] **Step 2: Write two-principal test**: route created by A cannot drive `write_file` under B; expect `ROUTE_PRINCIPAL_MISMATCH`.
- [x] **Step 3: Write required-skill test**: route requiring one native skill blocks execution until `skill_load(id, routeContextId)` succeeds.
- [x] **Step 4: Implement `route-guard.ts`** so validation happens before filesystem/search/process service invocation.
- [x] **Step 5: Add route field + dependency description** to the 11 MCP schemas: `Obtain routeContextId from capability_route before using this tool.`
- [x] **Step 6: Preserve direct cleanup**: verify expired route context can never prevent `stop_process` on an existing process session.
- [x] **Step 7: Update operational tests** to create and reuse a legitimate route for each coherent workflow.
- [x] **Step 8: Run full operational/enforcement/build regression suite.**
- [x] **Step 9: Commit** `feat: enforce capability routing before execution`.

---

### Task 5: Upgrade native Router Skill and plugin package

**Files:**
- Modify: `plugin/agent-core/skills/agent-core-capability-router/SKILL.md`
- Modify: `plugin/agent-core/README.md`
- Modify: `README.md`
- Modify: `tests/plugin-package.test.ts`

**Desired invisible flow:**
```text
normal user brief
→ capability_route(task, context)
→ optional skill_load(id, routeContextId)
→ route-required Agent Core tools using the same routeContextId
→ verification from route policy
```

- [x] **Step 1: Extend plugin test** to require `capability_route`, `routeContextId`, and route-aware `skill_load` in the packaged Router Skill.
- [x] **Step 2: Update Router Skill** to call `capability_route` before every route-required Agent Core operation without asking the user to name routing primitives.
- [x] **Step 3: Reuse one route for one coherent user goal; create a new route only when the goal materially changes.**
- [x] **Step 4: Required native-ready skills use `skill_load(id, routeContextId)`; reference-only metadata is never instruction-loaded.**
- [x] **Step 5: Keep routing chatter internal** unless dependency/risk/failure information materially benefits the user.
- [x] **Step 6: Update README/plugin docs** for v0.5 automatic routing and the one-time ChatGPT Scan Tools + Router Skill refresh after deployment.
- [x] **Step 7: Run plugin tests and `npm run build:plugin`.**
- [x] **Step 8: Commit** `docs: make Agent Core routing a native reflex`.

---

### Task 6: Routing observability without prompt/skill leakage

**Files:**
- Modify: `src/logging/audit-log.ts`
- Modify: routing creation/validation call sites
- Test: `tests/routing-audit.test.ts`

**Routing audit event shape:**
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

- [x] **Step 1: Write failing audit tests** covering create/load/validate/reject flows.
- [x] **Step 2: Use sentinel task text, secret, OAuth token, and skill body in tests** and assert none appear in routing audit output.
- [x] **Step 3: Implement metadata-only routing audit helpers** alongside current request logging; do not duplicate transport logs.
- [x] **Step 4: Run routing-audit + OAuth + secret-leak regression tests.**
- [x] **Step 5: Commit** `feat: audit Agent Core routing decisions safely`.

---

### Task 7: End-to-end acceptance and v0.5.0 cutover

**Files:**
- Modify: `scripts/smoke-test.mjs`
- Modify: `tests/mcp-integration.test.ts`
- Runtime/app state: feature worktree, private `main`, Agent Core production runtime, ChatGPT Agent Core app tool snapshot, Router Skill.

**Acceptance contract:** 23 tools, `capability_route` present, public `capability_recommend` absent, route-required calls cannot bypass context, capability coverage preserved, native-ready gate preserved.

- [x] **Step 1: Extend smoke test for atomic flow:** `capability_route("Create a small proof file")` -> route-bound `write_file` -> route-bound `read_file`; assert `atomic_direct` and no required skill.
- [x] **Step 2: Add real-registry domain flow:** route `Improve a frontend dashboard visual hierarchy and spacing`; assert frontend-relevant recommendation and, when route requires a native-ready skill, load it with the same route ID before a harmless route-bound operation.
- [x] **Step 3: Add bypass smoke:** random route UUID is rejected with no side effect.
- [x] **Step 4: Run pre-cutover gates in isolated worktree:** full tests, build, plugin build, brand scan, non-production smoke.
- [x] **Step 5: Review tool schema diff:** exactly one capability tool rename and exactly 11 operational schemas gain route IDs; no unrelated permission/tool expansion.
- [x] **Step 6: Present implementation results to user and obtain explicit approval before merging/restarting production.**
- [x] **Step 7: After approval, merge/push private `main`, restart Agent Core v0.5.0, preserve rollback to verified v0.4.0.**
- [x] **Step 8: Refresh/Scan Tools once in ChatGPT Agent Core app** and update/install generated Router Skill.
- [x] **Step 9: Fresh-chat complex test with no routing jargon:** `@Agent Core perbaiki struktur dan kualitas frontend project ini, cek dulu projectnya lalu kerjakan dan verifikasi hasilnya.` Success requires internal `capability_route` -> optional `skill_load` -> route-bound execution -> verification.
- [x] **Step 10: Fresh-chat atomic test with no routing jargon:** `@Agent Core buat file route-proof.txt berisi "Agent Core automatic routing works".` Success requires internal route -> `atomic_direct` -> route-bound write, with no unrelated skill load.
- [ ] **Step 11: Final gate:** tunnel ready 200, Git clean, local `main == origin/main`, 23 live tools, routing enforcement active, coverage preserved, no tracked runtime/secrets/generated cache.

---

## Review Decisions Before Implementation Approval
These are deliberate defaults you can change now without rewriting the whole architecture:

1. **Enforcement breadth:** 11 tools including reads/search. This maximizes automatic behavior. Gating only writes/processes would be lighter but would allow complex read-only analysis to bypass routing if the native Skill is not selected.
2. **Route TTL:** 30 minutes.
3. **Required native skills:** at most 2 per route.
4. **Public surface:** replace `capability_recommend` with `capability_route`, keeping 23 tools. Temporary coexistence would mean 24 tools and another compatibility phase.
5. **Verification:** route output + Router Skill guide verification; no mandatory `route_complete` lifecycle yet.

## Plan Self-Review
- Reuses the current registry and execution services; no duplicate Agent Core subsystem.
- Hard automation exists through required, principal-bound route context validation.
- Soft intuition exists through the native Router Skill.
- Existing safety/workspace/auth controls remain independent and authoritative.
- Only audited native-ready skills may load full instructions.
- The plan does not pretend the 415 catalog records are 415 executable skills; native-ready expansion remains a separate follow-up.
- Production `main` stays on current v0.4.0 until implementation is complete, verified, reviewed, and explicitly approved.
