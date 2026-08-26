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
