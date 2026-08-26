# Codespace Anchor Gateway Checkpoint

## Objective
Keep the ChatGPT plugin front door fixed at `https://ominous-xylophone-69xxp4v76vv93xq64.app.github.dev/mcp` while allowing a replacement Codespace to become the Agent Core backend. Phase 1 requires the original Codespace to remain as the anchor; deleting it would remove the GitHub-owned hostname.

## Source of truth
- Design: `docs/superpowers/specs/2026-08-27-agent-core-codespace-anchor-gateway-design.md` (ignored framework artifact, copied into the isolated worktree)
- Plan: `docs/superpowers/plans/2026-08-27-agent-core-codespace-anchor-gateway.md` (ignored framework artifact, copied into the isolated worktree)
- Stable front door: `https://ominous-xylophone-69xxp4v76vv93xq64.app.github.dev`
- Anchor Codespace: `ominous-xylophone-69xxp4v76vv93xq64`
- Public anchor port: `8765`
- Local anchor fallback backend port: `8766`

## Checkpoint — Task 1: Anchor role/config contract

Status: COMPLETE / GREEN

Implemented:
- Added `src/codespace/anchor-config.ts` with the approved anchor identity, stable portless base URL, public port, local fallback port, and deterministic role resolver.
- Added matching Bash lifecycle helpers to `scripts/codespace/common.sh`.
- Non-anchor Codespaces retain service port `8765`; the anchor resolves its local Agent Core service port to `8766`.
- Added Vitest coverage for TypeScript/Bash contract parity.

Verification:
- `npm run build` — PASS.
- `npx vitest run tests/codespace-anchor-config.test.ts tests/codespace-contract.test.ts` — 2 files PASS, 13 tests PASS, 0 failures.

Repository comparison before Task 1 commit:
- Root `/workspaces/Agent-Core` remains on `main`; runtime source is untouched by worktree development.
- Feature worktree: `/workspaces/Agent-Core/.worktrees/codespace-anchor-gateway` on `feat/codespace-anchor-gateway`.
- Feature base: `42d0a20d89ae324f1f5a1774abd9deaeb32b91f9`.
- Root untracked `.vscode/` is unrelated and must remain untouched.

Next task: Task 2 — streaming anchor reverse proxy + OAuth identity normalization.

## Checkpoint — Task 2: Streaming reverse proxy + OAuth identity normalization

Status: COMPLETE / GREEN

Implemented:
- Added `src/codespace/anchor-proxy.ts` using only Node standard HTTP/HTTPS primitives.
- Proxy allowlists only Agent Core public health/MCP/OAuth surfaces.
- `/mcp` and normal OAuth/token traffic stream end-to-end; OAuth discovery JSON alone is bounded-buffered for identity normalization.
- `WWW-Authenticate` resource metadata, authorization-server metadata, and protected-resource metadata are rewritten to the stable anchor origin.
- Hop-by-hop/proxy authorization headers are stripped.
- Logging is restricted to method/path/backend mode and never includes authorization, cookies, request body, token, or API-key values.

Verification:
- `npm run build` — PASS.
- `npx vitest run tests/codespace-anchor-proxy.test.ts` — 1 file PASS, 7 tests PASS, 0 failures.
- Streaming test observed the first MCP/SSE chunk before the backend completed the response.

Task 2 source checkpoint will be the commit immediately following this note update.

Next task: Task 3 — atomic backend target state + verification.

## Checkpoint — Task 3: Atomic backend target state + verification

Status: COMPLETE / GREEN

Implemented:
- Added runtime-only target contract in `src/codespace/anchor-target.ts`.
- Missing/malformed state deterministically falls back to `http://127.0.0.1:8766`.
- Target writes use private `0600` temp files followed by atomic rename.
- Remote candidate validation requires HTTPS `*.app.github.dev`, rejects the anchor origin itself, requires healthy Agent Core `/health`, valid OAuth discovery, and unauthenticated `/mcp` HTTP 401.
- `verifyAndWriteRemoteBackend()` performs all verification before state mutation.
- Added `scripts/codespace/set-anchor-backend.sh` and `npm run codespace:anchor:set` for explicit local/remote switching from the anchor only.

Verification:
- `npm run build` — PASS.
- `npx vitest run tests/codespace-anchor-target.test.ts` — 1 file PASS, 7 tests PASS, 0 failures.

Next task: Task 4 — safe automatic backend discovery.

## Checkpoint — Task 4: Safe automatic backend discovery

Status: COMPLETE / GREEN

Implemented:
- Added `src/codespace/anchor-discovery.ts` with injectable `gh` runner for deterministic tests and bounded real GitHub CLI execution at runtime.
- Discovery filters the live canonical repository `ainoeviq-oss/Agent-Core`, excludes the configured anchor, accepts only `Available` replacement Codespaces, and inspects their port 8765 browse URL.
- Each candidate must pass the same Task 3 health/OAuth/MCP verifier before becoming eligible.
- Exactly one verified replacement is atomically selected.
- Zero verified replacements restore/keep local fallback.
- More than one verified replacement fails closed with `ANCHOR_DISCOVERY_AMBIGUOUS` and does not mutate the active target.
- Added executable `scripts/codespace/discover-anchor-backend.sh` and `npm run codespace:anchor:discover`.

Live contract observed before implementation:
- `gh codespace list --json name,repository,state` reported the current anchor as repository `ainoeviq-oss/Agent-Core`, state `Available`.

Verification:
- `npm run build` — PASS.
- `npx vitest run tests/codespace-anchor-discovery.test.ts` — 1 file PASS, 5 tests PASS, 0 failures.

Next task: Task 5 — lifecycle integration for anchor vs backend roles.

## Task 2 — Streaming proxy + OAuth identity normalization

- Status: GREEN
- Added `src/codespace/anchor-proxy.ts`.
- Added `tests/codespace-anchor-proxy.test.ts`.
- `/mcp` response path is streamed without response buffering.
- OAuth discovery/protected-resource JSON is bounded and normalized to the stable front-door base URL.
- Authorization/token/registration request bodies are proxied without logging secrets.
- Upstream failures fail closed as `502`.
- Focused verification: build PASS; 7/7 proxy tests PASS.

## Checkpoint — Task 5: Role-aware lifecycle + fresh-Codespace automation integration

Status: COMPLETE / GREEN

Implemented:
- Anchor local Agent Core service binds only `127.0.0.1:8766`; non-anchor Codespaces retain `0.0.0.0:8765`.
- Public anchor proxy owns port 8765 and resolves the active backend atomically on every request.
- Anchor supervisors are isolated as `agent-core-codespace-backend`, `agent-core-codespace-anchor`, and `agent-core-codespace-anchor-discovery`; ordinary backend Codespaces retain the existing `agent-core-codespace` supervisor.
- The lifecycle retires a legacy direct 8765 supervisor automatically before anchor proxy cutover, avoiding `EADDRINUSE` on upgrade.
- Missing anchor target state initializes to local fallback before public readiness.
- `watch-anchor-backend.sh` performs bounded recurring discovery without logging secrets; ambiguity/failure preserves the last verified target.
- Public port 8765 remains the only forwarded port; 8766 stays internal.
- Anchor READY uses the portless stable anchor origin and transport `codespace-anchor-gateway`; non-anchor behavior remains direct Codespaces unless an independent stable front door is configured.
- Existing `.devcontainer` create/start/attach hooks remain the canonical fresh-machine entrypoints.

Verification:
- `npm run build` — PASS.
- Anchor/config/proxy/target/discovery/lifecycle/Codespace/source-sync focused sweep — 7 files PASS, 49 tests PASS, 0 failures.
- `git diff --check` — PASS.

Fresh-machine guardrail:
All runtime behavior above is implemented in repository-tracked source/scripts; runtime target state, OAuth stores, database files, logs, and credentials remain outside Git.

Next task: prove the complete fresh-Codespace bootstrap inventory is tracked and reproducible, then implement a Codespace-deletion-surviving stable front door.

## Checkpoint — Fresh Codespace reproducibility gate

Status: COMPLETE / GREEN

Evidence:
- Added `tests/codespace-fresh-machine.test.ts` to require the complete fresh-Codespace automation inventory to remain tracked.
- The gate verifies `.devcontainer` create/start/attach hooks, only port 8765 forwarding, bootstrap prerequisites, Node/npm dependency recovery, source synchronization before build, automatic port-publicization, OAuth/MCP readiness gates, and runtime/secrets isolation.
- All `scripts/codespace/*.sh` entries are now stored with Git mode `100755`, not merely chmod'd in the current filesystem.
- Focused verification: 3 files / 24 tests PASS, 0 failures; `git diff --check` PASS.

Tracked automation includes `.devcontainer/devcontainer.json`, bootstrap/common/sync/ensure/show/start/set/discover/watch scripts, plus anchor config/proxy/server/target/discovery source. A fresh checkout therefore receives the automation instead of depending on mutable state from this Codespace.
