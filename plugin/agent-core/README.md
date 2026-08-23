# Agent Core Plugin Source

This directory is the local source workspace for packaging Agent Core as one workflow capability: native Skills plus the already-connected Agent Core MCP app.

## Components

- `skills/agent-core-capability-router/SKILL.md` — native routing reflex for actionable tasks.
- `generated/skills/*` — generated copies of audited `native_ready` skills only.
- `generated/agent-core-package.json` — internal package inventory. It is **not** claimed to be an OpenAI upload manifest.
- Agent Core app — the existing ChatGPT custom MCP app using the Secure MCP Tunnel and OAuth bridge.

## Build

From the Agent Core feature checkout:

```powershell
npm run build:plugin
```

The builder reads the stable registry under `F:\Projects\Agent Core-MCP\capabilities`, then packages only skills that passed source resolution, license verification, function analysis, and safety review.

Every imported skill carries its audited `PROVENANCE.json` and source `LICENSE` beside `SKILL.md`.

## Agent Core v0.5 automatic routing

The native Router Skill treats routing as an internal reflex. A normal user brief is preflighted with `capability_route`, the returned `routeContextId` is reused for one coherent goal, and any route-required audited skill is loaded with `skill_load(id, routeContextId)` before route-bound execution. Users should not have to name routing primitives themselves.

Only audited `native_ready` skills may be full-instruction-loaded. Reference-only, catalog-only, quarantined, unresolved, and unknown-license material remains metadata/reference material and is never loaded as executable skill guidance.

After an Agent Core v0.5.0 deployment, refresh the ChatGPT app tool snapshot once with **Scan Tools / Refresh Tools**, then update the Router Skill once so ChatGPT sees `capability_route` and the route-bound schemas containing `routeContextId`.

## ChatGPT packaging boundary

OpenAI currently documents that one Plugin may include multiple Skills and Apps, but does not publish a generic local plugin-manifest format equivalent to Agent Skills' `SKILL.md` standard. Therefore this workspace does not invent one.

When attaching this source to ChatGPT, keep the existing `Agent Core` app as the app component and use the Skills from this package as the plugin's skill components. App OAuth/tunnel credentials remain in the existing app/runtime and are never copied into the skill package.

The capability registry remains deferred behind MCP. The package should not contain the entire 415-item catalog as full instructions; only audited `native_ready` skills are materialized.
