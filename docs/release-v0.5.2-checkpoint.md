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

## Published GitHub state

- Release repository: `ainoeviq-oss/Agent-Core`
- Release ID: `377294057`
- Release tag: `v0.5.2`
- Release source commit: `29caa5eb73b8bea848d285531e240e113b953d7b`
- Release state: published, non-draft, non-prerelease.
- GitHub Release page: `https://github.com/ainoeviq-oss/Agent-Core/releases/tag/v0.5.2`

### Verified assets

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `agent-core-windows-v0.5.2-stable.zip` | 580790 | `23065dc86a3fba1add46862a9c39f5e05011a6cd886b51f07717e1780d17b349` |
| `agent-core-plugin-v0.5.2-stable.zip` | 12240 | `cdd34df6ade4737c82c88e9d27b25b65482601bae833851fc2afd90e886a8d68` |
| `rendevouz999-agent-core-plugin-0.5.2.tgz` | 9947 | `c0719ebc96701783897e868fc17996e6902d3dc60048c1ac869aa6b2e5cb0972` |
| `release-manifest.json` | 1102 | `fac368e39ab354eb941af91cc1b22de6ec80e6f52b115dc6506450f19359b127` |
| `SHA256SUMS.txt` | 400 | GitHub asset digest `424715916987d7c40afd618532f0e0b20ffc2529f63c6bfe263e963b9e7bd4ed` |

Independent local SHA-256 verification passed before upload, and GitHub's asset digests match the locally calculated hashes for the runtime ZIP, plugin ZIP, npm TGZ, and release manifest.

## Package publication status

The npm-compatible plugin package is published to the repository as the release asset `rendevouz999-agent-core-plugin-0.5.2.tgz`, alongside the plugin ZIP. The optional GitHub Packages registry publication could not be performed because the dedicated packages credential file `/workspaces/Agent-Core/secrets/github/packages-token.txt` is not configured. No token was copied, substituted, exposed, or synthesized. This does not affect the durable GitHub Release package assets.

## Final release boundary

`v0.5.2` intentionally remains pinned to the exact package source commit `29caa5eb73b8bea848d285531e240e113b953d7b`. This post-publication checkpoint is a documentation-only main-branch commit and is not part of the packaged source boundary.
