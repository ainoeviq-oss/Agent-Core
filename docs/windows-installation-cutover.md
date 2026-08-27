# Windows Installation Cutover

Date: 2026-08-27
Status: Applied and verified on the live Windows installation

## Objective

Relocate the authoritative Windows Agent Core installation from a long-lived working
checkout to a clean clone of canonical `main`, without forcing the connected MCP client
to re-pair.

The cutover must establish this factual chain end to end:

`canonical main -> fresh clone -> inherited auth identity -> live process -> tunnel -> connector`

A cutover is only complete when the live runtime reports the new version *and* the
connector authenticates with the key identity it already held.

## Why a clone alone is not enough

Agent Core keeps its durable authentication state under `runtime/data/`, which is
ignored by Git. A fresh clone therefore starts with **no** key store and an **empty**
OAuth store. Source parity does not imply credential parity.

Two files, and only these two, determine whether an existing client keeps working:

| File | Owner | Determines |
| --- | --- | --- |
| `runtime/data/keys.json` | `src/auth/key-store.ts` | API key identity (`id`, `name`, scrypt `salt` + `hash`) |
| `runtime/data/oauth.json` | `src/oauth/store.ts` | Registered OAuth clients, authorization codes, access and refresh tokens |

Both resolve from `AGENT_CORE_DATA_DIR`, which the tray sets to `<root>\runtime\data`.

Copying a plaintext key file is **not** sufficient. `secrets/agent-core-chatgpt-key.txt`
is an operator convenience copy; no runtime code path reads it. Verification happens
against the scrypt record in `keys.json`, so a target installation missing that record
rejects the very key the operator just copied.

## Issues encountered and fixes

### 1. Empty authentication stores on the new installation

**Symptom.** After starting the new installation, the connector session dropped and
reported `Session terminated`. Restarting the old installation restored it, which made
the failure look like a process-lifecycle problem rather than a credential problem.

**Root cause.** The new installation had no `runtime/data/keys.json` at all, and its
`runtime/data/oauth.json` was a 96-byte empty store (`clients: []`). The client
presented a `client_id` and refresh token that the new store had never registered.

**Fix.** Copy both store files verbatim from the previous installation while it is
stopped, so the snapshot is final:

```powershell
Copy-Item "<old>\runtime\data\keys.json"  "<new>\runtime\data\keys.json"  -Force
Copy-Item "<old>\runtime\data\oauth.json" "<new>\runtime\data\oauth.json" -Force
```

Both stores are `version: 1` and their schemas are unchanged across these releases, so a
verbatim copy is safe. Back up the target directory first.

**Verification.** Authenticate against the live endpoint and read the audit record
rather than trusting the HTTP status alone:

```bash
grep '"route":"/mcp"' runtime/logs/audit.jsonl | grep '"status":200' | tail -1
```

The `keyId` and `keyName` fields must match the previous installation. A `200` proves
only that *some* key verified; the audit record proves *which*.

### 2. A required secret file was deleted as an apparent duplicate

**Symptom.** The Agent Core process started and served `/health`, but the tray bundle
never completed and the tunnel port stayed closed, so the connector could not reach the
runtime at all.

```text
parse config file agent-core.yaml: invalid control_plane.api_key reference
"file:secrets/control-plane-api-key-restored.txt": read file: ...
The system cannot find the file specified.
```

**Root cause.** The two installations legitimately reference different secret filenames:

| Installation | `control_plane.api_key` reference |
| --- | --- |
| previous | `file:secrets/control-plane-api-key.txt` |
| current (canonical) | `file:secrets/control-plane-api-key-restored.txt` |

The `-restored` name is the canonical contract. It is baked into the tracked template
`tunnel-client/agent-core.example.yaml` and asserted by `tests/unified-launcher.test.ts`,
which requires every tunnel profile to reference that exact relative path and to contain
no absolute path.

During cleanup the `-restored` file was deleted because its contents were byte-identical
to the file carried over from the previous installation, making it look like a stray
duplicate. It was not a duplicate — it was the file the active configuration named.

**Wrong fix.** Repointing `agent-core.yaml` at the older filename makes the tunnel start
again, but it silently breaks the tracked contract and fails the portability test. A
green tunnel is not sufficient evidence that a configuration change was correct.

**Correct fix.** Restore the file and leave the profile matching the tracked template:

```yaml
api_key: "file:secrets/control-plane-api-key-restored.txt"
```

**Verification.** `GET http://127.0.0.1:8787/readyz` returns `200`, the operator profile
matches `agent-core.example.yaml`, and `npx vitest run tests/unified-launcher.test.ts`
passes.

**Lessons.**

- A file under an ignored path can still be part of a tracked configuration contract.
  Before deleting one, search the tree for its name — `git grep control-plane-api-key`
  would have shown the template and the test immediately.
- When diffing configuration files, redact only the secret *value*, never the whole
  line. An earlier comparison of these two profiles wrongly reported them identical
  because the redaction pattern masked the `api_key` line — the only line that differed.
- Operator tooling carried over from an older installation may encode the older
  filename. `Set-Tunnel-Key.ps1` writes `control-plane-api-key.txt`, so after a rename
  it no longer updates the file the profile actually reads. Both filenames are kept in
  sync in this installation; rotating the key must update whichever name the active
  profile references.

### 3. Machine-level root locator not repointed

**Symptom.** After a cutover attempt the runtime resolved back to the old installation.

**Root cause.** `%LOCALAPPDATA%\AgentCore\root.txt` records the active installation root.
`scripts/windows/agent-core-launcher.ps1` rewrites it, but only when startup goes through
the launcher. Driving the tray directly with `-Mode StartBundle` bypasses that write, so
the locator kept naming the old root and any launcher-based path returned to it.

**Fix.** Either start the new installation through `Start-Agent-Core.bat`, or write the
locator explicitly when starting the tray directly:

```powershell
[IO.File]::WriteAllText("$env:LOCALAPPDATA\AgentCore\root.txt", '<new root>',
  (New-Object Text.UTF8Encoding($false)))
```

**Verification.** `Get-Content "$env:LOCALAPPDATA\AgentCore\root.txt"` names the new root,
and the processes listening on the Agent Core and tunnel ports both originate from it.

### 4. Leaked test processes and temporary directories

**Symptom.** Thirteen orphaned `node.exe` processes running `fake-tunnel.mjs` from
`%TEMP%\agent-core-tray-*`, left behind by tray test fixtures.

**Impact.** No functional impact on the runtime, but they obscure process inspection
during a cutover, when identifying which process owns a port matters.

**Fix.** Terminate processes whose command line contains `fake-`, then remove the
matching `%TEMP%\agent-core-tray-*` directories.

**Verification.** No `node.exe` process has `fake-` in its command line and no
`agent-core-tray-*` directory remains under `%TEMP%`.

### 5. Stale cutover marker asserting success

**Symptom.** `runtime/cutover-result.json` recorded `"ok": true` with a `0.5.3` health
payload, while the runtime actually serving the connector was still the old version.

**Root cause.** The marker captured a transient state during a cutover that later rolled
back. Nothing invalidated it afterwards, so it survived as a false success record.

**Fix.** Remove markers that outlive the operation they describe. Cutover success is
established by live evidence — health version, tunnel readiness, and the audit record —
not by a stored flag.

## Decommissioning the previous installation

Deleting the old installation is irreversible, so confirm that nothing unique lives there
before removing it. In this cutover the old checkout still held 111 uncommitted changes.
They were assessed as follows.

**Ancestry.** The old checkout's `HEAD` was a direct ancestor of canonical `main`, with 41
commits in between. The new installation was strictly ahead on the same line of history,
not a divergent branch.

**Content.** Of 110 modified tracked files, 73 were byte-identical to their counterparts
in the new installation. The remaining 37 were compared as line sets: 1,464 lines were
unique to the new installation, 153 to the old. Every one of those 153 lines was a
refactoring artifact — for example a hardcoded `spawnPowerShell` helper that had been
generalized into `spawnCommand` with `resolveShellInvocation` in
`src/runtime/platform-shell.ts`. Twenty-six core identifiers were checked individually;
all survived, either unchanged or in a broader form.

**Content that existed only in the old installation.** Operator tooling under ignored
paths does not travel with a clone and must be copied deliberately:

- `secrets/github/` helper scripts (`gh.ps1`, `packages.ps1`, `package-api-status.ps1`,
  `repo-status.ps1`, `README.txt`)
- `Set-Tunnel-Key.bat` and `Set-Tunnel-Key.ps1`

These were copied to the new installation before deletion. Because they live under
ignored paths, copying them keeps the tracked tree identical to canonical.

## Cutover checklist

1. Prove the new clone matches canonical: `git status --porcelain` is empty and local
   `HEAD` equals remote `main`.
2. Confirm no work exists only in the old checkout — check uncommitted changes, local
   commits absent from every remote, stashes, and worktrees.
3. Copy ignored operator tooling that a clone does not carry.
4. Stop the old bundle so its stores reach a final state, and confirm both ports are free.
5. Back up the target `runtime/data`, then copy `keys.json` and `oauth.json` verbatim.
6. Confirm the tunnel profile matches `tunnel-client/agent-core.example.yaml` and that
   every secret file it references exists.
7. Start the new bundle and tray, then point the machine locator at the new root.
8. Verify health version, tunnel readiness, and the audit record's `keyId` / `keyName`.
9. Only then remove the old installation.

Keep the previous installation until the connector has been exercised end to end. Until
that point it remains the only proven rollback path.

## Verification evidence

Recorded on the live installation after the fixes above were applied.

| Gate | Result |
| --- | --- |
| `npm run verify` (brand scan, TypeScript build, full suite) | exit `0` |
| Test suite | 96 files passed, 1 skipped; 461 tests passed, 20 skipped, 0 failed |
| `scripts/release/check-doc-links.mjs` | `ok: true`, 28 markdown files, 23 relative links |
| `scripts/check-agent-core-brand.mjs` | clean |
| `GET /health` | `status: ok`, `version: 0.5.3`, memory / continuity / execution healthy |
| `GET /readyz` (tunnel) | `200` |
| `POST /mcp` without credentials | `401` |
| `POST /mcp` with the pre-existing key | `200` |
| Audit record for that request | `keyId` and `keyName` match the previous installation |
| Tracked tree vs canonical `main` | identical, `0` modified files, `0/0` ahead/behind |
| References to the previous installation root inside the new tree | none |

The full suite is the gate that caught the incorrect fix in issue 2. A tunnel that
starts, a health endpoint that answers, and a connector that authenticates were all true
while `tests/unified-launcher.test.ts` was still failing. Live behaviour and the test
suite answer different questions; a cutover needs both.
