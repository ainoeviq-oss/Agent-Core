# Agent Core v0.5.3 Stable Release Checkpoint

Date: 2026-08-27
Status: Release gate PASS; pending commit/tag/package/publication

## Why v0.5.3 exists

v0.5.2 was already published from immutable source commit:

`29caa5eb73b8bea848d285531e240e113b953d7b`

A real Codespace restart later exposed a lifecycle correctness bug: automation could build or accept stale source/process state and still report `READY`. The fix was implemented and verified after v0.5.2, so the v0.5.2 tag/release must remain unchanged. This stable fix is therefore a new patch release: v0.5.3.

## Source-sync fix

Verified fix feature checkpoint:

`481b7d9627e2b6cb2818d0692bf1720cd31d8692`

Live proof checkpoint commit on main:

`1674140da1d41c72b2260dc5f409385fa11349f3`

The fixed lifecycle now establishes:

`origin/main -> local HEAD -> dependency/build -> running process -> version-aware local/public health -> verified connection metadata -> READY`

Automatic synchronization is deliberately conservative:

- clean `main` behind `origin/main`: bounded fetch + `--ff-only` update;
- equal: idempotent success;
- tracked dirty: fail closed;
- non-main/detached: fail closed;
- local ahead: fail closed;
- diverged: fail closed;
- untracked files such as `.vscode` remain preserved.

## Live integrated proof

The integrated attach repair produced:

```text
Source checkout already matches origin/main at 481b7d9627e2b6cb2818d0692bf1720cd31d8692.
ERROR: Local health did not become ready at synchronized source version 0.5.2; performing one controlled service restart.
Local Agent Core health is verified at source version 0.5.2.
Forwarded port 8765 is public.
READY: all local, forwarding, public-health, OAuth, and MCP-auth gates passed.
```

That transient error is expected proof that the stale process was rejected rather than accepted as READY.

Post-restart assertion:

`SOURCE_PROCESS_METADATA_AGREEMENT=PASS`

At that proof point:

- local HEAD == origin/main == `connection.json.sourceCommit`;
- package version == local/public `/health.version` == live Agent Core version == `connection.json.sourceVersion`;
- `connection.json.sourceRemote=origin`;
- `connection.json.sourceBranch=main`;
- `.vscode` remained present;
- tracked tree remained clean.

## v0.5.3 active version contract

The following current-version contracts are synchronized to `0.5.3`:

- `package.json`;
- root/package entry in `package-lock.json`;
- `SERVER_VERSION`;
- Native GitHub Fabric User-Agent values;
- GitHub operator documentation;
- smoke test;
- MCP integration expectations;
- GitHub API tests;
- unified health lifecycle version expectation;
- CHANGELOG stable section.

Historical v0.5.2 checkpoint evidence is intentionally not rewritten.

## Canonical local release gate

Command:

`npm run verify:release`

Fresh v0.5.3 result:

- brand scan: PASS;
- TypeScript build: PASS;
- test files: 82 passed, 1 skipped;
- tests: 360 passed, 32 skipped;
- failures: 0;
- release consistency: PASS (`0.5.3`);
- tracked files inspected by release checker: 239;
- historical `docs/superpowers` tracked: 0;
- markdown files checked: 26;
- relative links checked: 22;
- `git diff --check`: PASS;
- GitHub Actions/CI: not used.

## Safety / publication policy

- no GitHub Actions/CI;
- no force push;
- no rewrite/move of v0.5.2;
- no secret values in source, logs, package, or release metadata;
- no Windows/local Agent Core access;
- package construction is local-direct;
- release assets must be audited for top-level secrets/runtime/data/logs/capabilities/node_modules/.env exclusion;
- package SHA-256 must be independently reverified before upload.

## Repository comparison before release commit

At release-gate time:

- local main base before release metadata commit: `1674140da1d41c72b2260dc5f409385fa11349f3`;
- `origin/main`: `1674140da1d41c72b2260dc5f409385fa11349f3`;
- v0.5.2 tag remains immutable on its prior source;
- source-sync historical feature branch remains available remotely as rollback evidence.

## Remaining publication gates

1. Commit/push v0.5.3 release metadata.
2. Verify exact `origin/main` SHA.
3. Create annotated immutable tag v0.5.3 on that exact source commit.
4. Build runtime ZIP, plugin ZIP, npm TGZ, release manifest and SHA256SUMS locally.
5. Audit package exclusions and independently reproduce all hashes.
6. Publish direct GitHub Release v0.5.3 and upload all assets.
7. Record release asset IDs/sizes/digests and publication checkpoint.
8. Activate live runtime v0.5.3 using the fixed lifecycle and verify source/process/metadata agreement again.
