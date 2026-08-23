# Commander Plugin Source

This directory is the local source workspace for packaging Commander as one workflow capability: native Skills plus the already-connected Desktop Commander MCP app.

## Components

- `skills/commander-capability-router/SKILL.md` — native routing reflex for actionable tasks.
- `generated/skills/*` — generated copies of audited `native_ready` skills only.
- `generated/commander-package.json` — internal package inventory. It is **not** claimed to be an OpenAI upload manifest.
- Desktop Commander app — the existing ChatGPT custom MCP app using the Secure MCP Tunnel and OAuth bridge.

## Build

From the Commander feature checkout:

```powershell
npm run build:plugin
```

The builder reads the stable registry under `F:\Projects\Commander-MCP\capabilities`, then packages only skills that passed source resolution, license verification, function analysis, and safety review.

Every imported skill carries its audited `PROVENANCE.json` and source `LICENSE` beside `SKILL.md`.

## ChatGPT packaging boundary

OpenAI currently documents that one Plugin may include multiple Skills and Apps, but does not publish a generic local plugin-manifest format equivalent to Agent Skills' `SKILL.md` standard. Therefore this workspace does not invent one.

When attaching this source to ChatGPT, keep the existing `Desktop Commander` app as the app component and use the Skills from this package as the plugin's skill components. App OAuth/tunnel credentials remain in the existing app/runtime and are never copied into the skill package.

The capability registry remains deferred behind MCP. The package should not contain the entire 415-item catalog as full instructions; only audited `native_ready` skills are materialized.
