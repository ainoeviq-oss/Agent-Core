# Agent Core v0.5.2 Release Checkpoint

Release channel: `stable`

## Purpose

This checkpoint separates the already-verified hardening implementation from the publication operation. It records the repository comparison and direct-local release path so publication can be resumed without repeating completed implementation work.

## Source baseline

- Previous stable tag: `v0.5.1` -> `663f78356308017c087aaa3bf912f3c1479420e4`
- Stable hardening main before semver cut: `6197d40e957b92fe1e019f79398edfbe27f07441`
- `v0.5.1..main`: 16 commits, therefore the new stable state must not reuse the old tag.
- Release version selected: `0.5.2` / tag `v0.5.2`.

## Publication policy

- GitHub Actions/CI: forbidden and not used.
- Verification: local/direct only.
- Push: normal non-force only.
- GitHub Release: direct API publication.
- Package assets: built locally from the exact tagged source using the repository release allowlist.
- GitHub Packages: publish the tracked plugin package to the `stable` dist-tag when dedicated package credentials are available; release ZIP/TGZ assets remain the durable repository package fallback.

## Expected release assets

- `agent-core-windows-v0.5.2-stable.zip`
- `agent-core-plugin-v0.5.2-stable.zip`
- `rendevouz999-agent-core-plugin-0.5.2.tgz`
- `release-manifest.json`
- `SHA256SUMS.txt`

## Repository comparison gate

Before tag/release creation, local `main`, `origin/main`, package version, lockfile version, MCP server version, active GitHub User-Agent version, smoke-test expectation, changelog release section, and release checkpoint must all describe v0.5.2 consistently.

Final tag, release ID, asset byte sizes and SHA-256 values are authoritative in the published GitHub Release and its uploaded `SHA256SUMS.txt` / `release-manifest.json`.

## Local release verification

- `npm run verify:release`: PASS
- Brand scan: PASS
- TypeScript build: PASS
- Test files: 81 passed / 1 skipped
- Tests: 351 passed / 32 skipped
- Failures: 0
- Release consistency: PASS (`0.5.2`)
- Markdown link check: 24 files / 22 relative links / PASS
- GitHub Actions/CI invoked: no
