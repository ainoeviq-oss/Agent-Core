# Agent Core Automatic Capability Routing Design

## Goal
Turn Agent Core's existing capability registry from an optional discovery feature into the default execution reflex for Agent Core work, without requiring the user to mention capability tools, skill names, or routing commands.

The desired user experience is simple: the user gives a normal brief, ChatGPT selects Agent Core when useful, Agent Core creates a routing context from that brief, audited skills are loaded only when appropriate, and operational tools execute under that context.

## Current Baseline
Agent Core v0.4.0 already exposes 23 MCP tools: 2 identity tools, 15 operational tools, and 6 capability tools. `CapabilityRegistry` already provides search, recommend, metadata lookup, dependency inspection, coverage, and audited `skill_load`. The native `agent-core-capability-router` Skill already asks ChatGPT to preflight actionable work, but that behavior is advisory: current operational tools do not require evidence that routing happened.

The automatic-routing work must reuse these systems rather than create a parallel registry or a second execution layer.

## Core Architecture
The approved direction is **Hybrid Reflex Enforcement**:

1. **Soft reflex:** the native Agent Core Capability Router Skill tells ChatGPT to route Agent Core work automatically and keeps simple conversation out of tool workflows.
2. **Hard execution gate:** Agent Core operational tools validate a server-issued `routeContextId` before task execution. A fabricated, expired, foreign, or incomplete route context is rejected.
3. **Deterministic server router:** no second LLM, Ollama model, or hidden autonomous agent is added. The server uses the existing registry, task/context supplied by ChatGPT, deterministic classification, capability scores, risk metadata, and native-ready state.
4. **Deferred loading:** full skill instructions remain unloaded until a selected capability is `native_ready`. Catalog/reference-only material can inform routing metadata but can never become executable instructions.

## Canonical Routing Primitive
Expose `capability_route` as the canonical routing MCP primitive and remove `capability_recommend` from the public MCP surface in the same release. The internal `CapabilityRegistry.recommend()` method remains reusable by the router.

This replacement keeps the public Agent Core tool count at **23** rather than growing it to 24.

### Input
```ts
interface CapabilityRouteInput {
  task: string;
  context?: string;
}
```

`task` is a concise representation of the user's actual goal. `context` may contain bounded workspace/domain facts that materially affect routing. The user never has to compose these fields manually; ChatGPT supplies them when invoking the tool.

### Output
```ts
type RouteTier = 'atomic' | 'structured' | 'domain_complex' | 'high_impact';
type RouteMode = 'atomic_direct' | 'capability_guided' | 'skill_guided';

interface RouteDecision {
  routeContextId: string;
  tier: RouteTier;
  mode: RouteMode;
  domain: string;
  confidence: number;
  risk: 'low' | 'medium' | 'high' | 'unknown';
  recommendedCapabilities: CapabilitySummary[];
  requiredSkillLoads: Array<{ id: string; name: string }>;
  allowedTools: string[];
  verification: {
    required: boolean;
    suggestedTools: string[];
  };
  reasonCodes: string[];
  expiresAt: string;
}
```

The response remains compact; it does not include full third-party instructions.

## Task Tiers
### Atomic
One direct, narrow operation with no meaningful domain workflow, for example creating one file with supplied content or reading one known file. The router still issues a route context, but does not require a skill load.

### Structured
A multi-step task that benefits from explicit workflow ordering but does not strongly match a specialized audited skill. Routing returns capability metadata and a verification policy; execution may proceed without a full skill load.

### Domain Complex
A task such as frontend refactoring, debugging, testing, security review, presentation workflow, or another specialized domain with meaningful capability matches. Native-ready relevant skills may become required loads before execution.

### High Impact
A task whose requested effect, matched capability risk, or execution shape is materially higher impact. Routing is mandatory and verification is mandatory. Existing ChatGPT permissions, Agent Core workspace boundaries, blocked-command logic, and higher-level safety rules remain authoritative; the router does not invent a replacement permission system.

## Route Context Lifecycle
Create an in-memory `RouteContextStore` shared through `RuntimeServices`. It survives individual stateless MCP HTTP requests because `RuntimeServices` already survives those requests, but it does not persist across Agent Core restarts.

Each route context stores:
- cryptographically unpredictable `routeContextId`;
- authenticated Agent Core key/OAuth principal ID;
- task tier, mode, risk, reason codes, allowed tools, and required skill IDs;
- loaded skill IDs;
- created/expiry timestamps;
- bounded in-memory task/context text only for the lifetime of the route.

Default TTL: **30 minutes**. Expired contexts are pruned opportunistically. Limit active contexts to **256** total; prune expired then oldest contexts before admitting more.

Route IDs are never accepted across authenticated principals.

## Route Enforcement Matrix
The following operational tools require a valid `routeContextId`:
- `list_directory`
- `read_file`
- `read_multiple_files`
- `write_file`
- `edit_file`
- `create_directory`
- `move_file`
- `get_file_info`
- `search_files`
- `execute_command`
- `start_process`

The following remain direct because they are identity/bootstrap/capability discovery or process recovery operations:
- `agent_core_status`
- `agent_core_capabilities`
- `workspace_info`
- `capability_route`
- `capability_search`
- `capability_get`
- `skill_load`
- `capability_dependencies`
- `capability_coverage`
- `read_process_output`
- `stop_process`
- `list_processes`

Keeping `stop_process` outside the route gate ensures a stale or expired routing context can never prevent cleanup of an already-running Agent Core process.

## Tool Schema Contract
Every route-required tool gains:
```ts
routeContextId: z.string().uuid()
```

The tool description explicitly says the value must come from `capability_route`. This creates a model-visible dependency in addition to runtime enforcement.

The server validates:
1. route exists;
2. route is not expired;
3. route belongs to the current authenticated key/OAuth principal;
4. requested tool is allowed by the route;
5. every `requiredSkillLoads` item has been loaded for this route.

Failure returns a structured MCP tool error with one of these stable codes:
- `ROUTING_REQUIRED`
- `ROUTE_NOT_FOUND`
- `ROUTE_EXPIRED`
- `ROUTE_PRINCIPAL_MISMATCH`
- `ROUTE_TOOL_NOT_ALLOWED`
- `ROUTE_SKILL_REQUIRED`

No operational function is invoked when validation fails.

## Route-Aware Skill Loading
Extend `skill_load` input to:
```ts
{
  id: string;
  routeContextId?: string;
}
```

Without a route ID, `skill_load` retains its current manual/inspection behavior. With a route ID, Agent Core validates ownership and marks the audited native-ready skill as loaded for that route.

A route may only require a skill when the capability is already `native_ready`, `nativeEligible`, and loadable by the existing audit gate. Non-native recommendations never block execution merely because they cannot be loaded.

## Routing Decision Rules
The router consumes the existing `CapabilityRegistry` instead of duplicating its catalog. It combines:
- lexical/category/trigger scores from current recommendation logic;
- capability type and invocation metadata;
- capability state and risk;
- native-ready eligibility;
- task shape signals such as single atomic verb vs multi-step/domain workflow;
- high-impact execution signals only as routing metadata, not as a replacement safety policy.

Native-ready status receives a meaningful preference only after relevance. A weakly related native-ready skill must not outrank a strongly relevant reference capability solely because it is loadable.

The router must produce deterministic output for the same registry/task/context inputs.

## Native Router Skill
Update `agent-core-capability-router` so ChatGPT treats `capability_route` as the default Agent Core preflight. It must:
- never ask the user to name capability tools;
- call `capability_route` before any route-required Agent Core tool;
- reuse one route context across one coherent task;
- call `skill_load(id, routeContextId)` only for required/relevant native-ready skills;
- preserve user intent and existing tool permission boundaries;
- keep routing chatter hidden unless risk/dependency/failure information materially helps the user;
- start a fresh route when the user's goal materially changes.

The hard gate remains authoritative if the Skill is not selected by ChatGPT.

## Verification Policy
Routing does not replace normal testing or output verification. Route decisions return a lightweight verification policy:
- atomic read-only: verification normally false;
- atomic mutation: verification true when a cheap read-back exists;
- structured/domain tasks: verification true;
- high-impact tasks: verification true.

This release guides verification through the route output and Router Skill. It does **not** add a separate persisted `route_complete` workflow; that can be evaluated later from real usage telemetry.

## Observability
Audit logs record routing metadata without raw user prompt contents:
- route context ID;
- principal/key ID;
- tier/mode/risk;
- recommended capability IDs;
- required/loaded skill IDs;
- tool validation result/error code;
- route creation/expiry timestamps.

Do not log raw API keys, OAuth tokens, full loaded skill instructions, or full task/context text.

## Version and Surface
This is an interface-changing release. Target server version: **0.5.0**.

`agent_core_capabilities` reports stage `v4-automatic-capability-routing` and includes routing enforcement metadata.

Public tool count remains 23 by replacing `capability_recommend` with `capability_route`.

## Rollout Strategy
Do not modify the current production `main` until the feature branch passes the full suite.

Cutover sequence:
1. implement/test on isolated branch/worktree;
2. verify tool surface and routing enforcement locally;
3. build updated Agent Core plugin/router skill;
4. merge only after review;
5. restart Agent Core production;
6. refresh/Scan Tools for the Agent Core ChatGPT app once because tool schema changes;
7. install/update the Router Skill;
8. run fresh-chat acceptance using normal user briefs that never mention routing tools.

Rollback is the previous verified v0.4.0 `main` plus the existing runtime backup strategy.

## Acceptance Scenarios
### Atomic user brief
User: “Create `notes.txt` containing hello.”
Expected internal flow: `capability_route` -> `atomic_direct` -> `write_file(routeContextId=...)` -> cheap read-back verification. No skill load required.

### Domain-complex user brief
User: “Improve this frontend dashboard so the visual hierarchy and spacing feel professional.”
Expected internal flow: `capability_route` -> relevant frontend capabilities -> audited native-ready skill if relevant -> `skill_load(..., routeContextId)` -> file/search/process operations with the same route context -> verification.

### Attempted bypass
A route-required operational call with no/invalid/foreign/expired context must fail before filesystem/process execution.

### Catalog-only recommendation
A strongly relevant capability that is not native-ready may appear in recommendations, but Agent Core must not load its instructions and must not block safe generic execution solely because it is reference-only.

## Non-Goals
- Adding another LLM or local model behind Agent Core.
- Autonomous subagents or parallel agent orchestration.
- Automatically installing third-party skills/packages/hooks.
- Increasing native-ready coverage from 1 to hundreds in this same change.
- GUI automation, semantic Git tools, broad system administration, or external app adapters.
- Replacing ChatGPT/OpenAI permission and safety controls.
- Persisting route contexts across process restarts.

## Follow-Up After This Release
The largest remaining capability bottleneck will still be audit coverage: the registry knows hundreds of capabilities but only audited native-ready skills can be loaded. After automatic routing is empirically proven, the next independent project should expand source/license/function/safety auditing and native-ready coverage without weakening the gate.
