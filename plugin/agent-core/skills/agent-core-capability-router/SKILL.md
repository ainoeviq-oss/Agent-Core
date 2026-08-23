---
name: agent-core-capability-router
description: Automatically preflight actionable Agent Core work with capability_route, keep one routeContextId for each coherent goal, load only audited native-ready skills when required, and execute route-bound tools without asking the user for routing jargon.
---

# Agent Core Capability Router

Treat this skill as an invisible capability-selection reflex for actionable work.
Do not turn purely conversational prompts into a tool workflow, and do not make the user name internal routing primitives.

## Preflight

1. Determine whether the request needs external action, files, code, search, process execution, structured workflow, or specialized guidance.
2. If not, answer normally and stop routing.
3. If yes and Agent Core is available, call `capability_route` with a concise description of the actual task plus only the context needed to route it safely.
4. Capture the returned `routeContextId` and keep it attached to all route-required Agent Core operations for that coherent user goal.
5. Reuse the same `routeContextId` while the goal is materially unchanged. Create a new route only when the goal materially changes.
6. Inspect `capability_get` or `capability_dependencies` only when risk, provenance, requirements, or dependencies are unclear.
7. If the selected route requires a skill, load only that audited skill with `skill_load(id, routeContextId)` before route-bound execution.
8. Only a selected capability explicitly marked `native_ready` may be full-instruction-loaded. Catalog-only, quarantined, unresolved, reference-only, or unknown-license material must never be full-instruction-loaded.

## Execution

Before any route-required operation, ensure the current coherent goal has a valid route. Do not bypass a missing, expired, principal-mismatched, tool-disallowed, or skill-incomplete route.

- Preserve the user's explicit brief, constraints, and requested output.
- Prefer read/search operations before mutation when understanding is incomplete.
- Pass the same `routeContextId` to every route-required operation that belongs to the current goal.
- Use a loaded skill's methodology only where relevant; it does not replace tool permission boundaries or user intent.
- Do not execute Hooks automatically merely because the catalog contains them.
- Treat Agents as expert guidance unless a real subagent runtime is explicitly available.
- Treat Commands as recipes, not permission to run arbitrary shell commands.
- If routing fails, surface the stable failure only when the user can act on it; never silently bypass route enforcement.
- Bootstrap and recovery tools that are intentionally direct may still be used for diagnosis or stopping an already-running process.

## Context discipline

Keep capability discovery, route creation, route reuse, and skill-loading chatter internal by default. Surface it only when a risk, dependency, required approval, or routing failure materially helps the user.

Do not speculatively load multiple full skills. Route first, select the minimum audited capability needed, then load only a required `native_ready` skill.

The user should be able to give a normal brief. Automatic routing is an implementation detail, not a prompt requirement.
