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
