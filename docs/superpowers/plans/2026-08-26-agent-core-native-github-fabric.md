# Agent Core Native GitHub Fabric Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class Native GitHub Fabric to Agent Core that uses Node `fetch()` plus `git.exe`, reads GitHub credentials lazily from project-local secret files, exposes route-aware GitHub MCP tools, supports GitHub Packages, and never persists or discloses token values.

**Architecture:** Add a focused `src/github/` subsystem with credential, REST, Git transport, package transport, safety/error, and façade services. Wire it into `RuntimeServices`, expose one direct diagnostic tool plus eight route-gated GitHub MCP tools, and keep all secret-bearing material inside transient service/process boundaries. Authenticated Git uses `GIT_ASKPASS` and an inherited environment variable rather than token-bearing command arguments or remote URLs; npm package operations use a transient user config deleted in `finally`.

**Tech Stack:** Node.js 24, TypeScript 7, built-in `fetch`, `node:child_process.spawn`, `git.exe`, npm CLI, MCP SDK 1.30, Zod 4, Vitest 4.

**Spec:** `docs/superpowers/specs/2026-08-26-agent-core-native-github-fabric-design.md`

## Global Constraints

- Do not install or depend on GitHub CLI (`gh`).
- Do not create or use `.worktrees`; implementation occurs inline in `E:\Projects\Agent-Core` on the existing `main` checkout with explicit user approval.
- Do not stage or commit the untracked `stable-release/` directory.
- Never print, log, hash, fingerprint, return, or persist contents of `secrets/github/gh-token.txt` or `secrets/github/packages-token.txt`.
- Default credential paths are project-relative; never hardcode drive `E:` in production source.
- GitHub REST requests use `Accept: application/vnd.github+json` and `X-GitHub-Api-Version: 2026-03-10` by default.
- Caller-controlled authorization/cookie/proxy-authorization headers are rejected before network side effects.
- Generic REST endpoints must remain within the configured GitHub API origin.
- `github_status` is direct and local-only; every other GitHub MCP tool requires a valid principal-bound `routeContextId`.
- Destructive operations require the exact literal `CONFIRM_GITHUB_DESTRUCTIVE_OPERATION` before any network/process side effect.
- Audit/memory records may contain safe operation/repository/path/status metadata only; never arbitrary response bodies or credential-bearing environment/config data.
- TDD is mandatory: each production behavior starts with a failing test that is observed to fail for the intended reason.
- Commit coherent milestones only after fresh focused tests and build/type verification for that milestone.
- Live acceptance is read-only and occurs only after deterministic tests pass.

---

## File Structure

### New production files

- `src/github/types.ts` — public/internal GitHub config, result, operation, and error types.
- `src/github/errors.ts` — stable `GitHubFabricError` codes, safe redaction, HTTP/Git/npm error classification.
- `src/github/credentials.ts` — project-relative credential paths, lazy reads, configured-status metadata.
- `src/github/safety.ts` — destructive confirmation constant/classifier and safe header/endpoint validation helpers.
- `src/github/api-service.ts` — authenticated GitHub REST transport and response normalization.
- `src/github/process.ts` — bounded direct child-process runner using argument arrays and redacted output.
- `src/github/git-service.ts` — authenticated HTTPS Git transport using `GIT_ASKPASS`, no persisted credentials.
- `src/github/package-service.ts` — package REST helpers and transient npm registry operations.
- `src/github/service.ts` — façade combining credential/API/Git/package services and convenience endpoint mappings.
- `src/mcp/github-tools.ts` — MCP schemas, route/audit integration, operation dispatch, safe result/error shaping.
- `plugin/agent-core/skills/agent-core-github/SKILL.md` — tracked native usage policy for ChatGPT/Agent Core.

### New test files

- `tests/github-config-credentials.test.ts`
- `tests/github-api.test.ts`
- `tests/github-git.test.ts`
- `tests/github-packages.test.ts`
- `tests/github-mcp.test.ts`
- `tests/github-secret-leakage.test.ts`
- `tests/github-live.acceptance.test.ts` — opt-in live probe, skipped unless explicitly enabled.

### Modified files

- `src/config.ts` — add `GitHubConfig` and environment/default resolution.
- `src/runtime/services.ts` — create/expose `github: GitHubService`.
- `src/mcp/server.ts` — register GitHub tools and capability names.
- `src/memory/operational-audit.ts` — allow safe GitHub audit scalar keys only; never credential/body/header values.
- `tests/config.test.ts` — GitHub config defaults and overrides.
- `tests/mcp-toolset.test.ts` — GitHub direct/gated tool discovery contract.
- `tests/mcp-integration.test.ts` — expected tool count/capability presence updated without weakening existing checks.
- `scripts/release/build-release.ps1` — package both tracked native skills; keep `secrets` excluded.
- `tests/plugin-package.test.ts` — stable plugin package contains `agent-core-github` and no credential material.
- `scripts/release/check-release.mjs` and/or release tests — assert secret paths/token sentinels are absent.
- `plugin/agent-core/README.md` — document GitHub native tool layer and credential boundary without exposing values.
- `CHANGELOG.md` — record Native GitHub Fabric feature in current unreleased section if one exists; otherwise add a concise current-development entry without changing package version.

---

### Task 1: GitHub Configuration and Lazy Credential Boundary

**Files:**
- Create: `src/github/types.ts`
- Create: `src/github/errors.ts`
- Create: `src/github/credentials.ts`
- Modify: `src/config.ts`
- Modify: `tests/config.test.ts`
- Create: `tests/github-config-credentials.test.ts`

**Interfaces:**
- Produces:
  - `interface GitHubConfig { enabled: boolean; apiBaseUrl: string; apiVersion: string; tokenFile: string; packagesTokenFile: string; requestTimeoutMs: number; gitTimeoutMs: number; }`
  - `type GitHubCredentialKind = 'github' | 'packages'`
  - `interface GitHubCredentialStatus { githubTokenConfigured: boolean; packagesTokenConfigured: boolean; githubTokenPath: string; packagesTokenPath: string; }`
  - `class GitHubFabricError extends Error { code: GitHubErrorCode; details?: Record<string, unknown> }`
  - `class GitHubCredentialProvider { status(): Promise<GitHubCredentialStatus>; read(kind: GitHubCredentialKind): Promise<string>; redact(value: string, secrets: string[]): string; }`
- Consumes: `GitHubConfig`, project root/baseDir.

- [ ] **Step 1: Write failing config tests**

Add assertions to `tests/config.test.ts` that `loadConfig({}, baseDir).github` equals:

```ts
{
  enabled: true,
  apiBaseUrl: 'https://api.github.com',
  apiVersion: '2026-03-10',
  tokenFile: path.join(baseDir, 'secrets', 'github', 'gh-token.txt'),
  packagesTokenFile: path.join(baseDir, 'secrets', 'github', 'packages-token.txt'),
  requestTimeoutMs: 30_000,
  gitTimeoutMs: 120_000,
}
```

Extend the override test with all six GitHub environment variables and exact expected resolved paths/values.

- [ ] **Step 2: Run config tests and verify RED**

Run:

```powershell
npx vitest run tests/config.test.ts
```

Expected: FAIL because `AppConfig` has no `github` field/config resolution.

- [ ] **Step 3: Implement minimal GitHub config**

Add `GitHubConfig`, `github: GitHubConfig` to `AppConfig`, and default/override parsing in `loadConfig`. Reuse existing boolean/positive-integer parsing. Normalize `apiBaseUrl` by trimming trailing `/` only after URL validation; only `http:`/`https:` values are accepted by config, while production default remains HTTPS.

- [ ] **Step 4: Re-run config tests and verify GREEN**

Run the same focused command. Expected: PASS.

- [ ] **Step 5: Write failing credential-provider tests**

In `tests/github-config-credentials.test.ts`, use a temporary root with sentinel values:

```ts
const GH = 'SENTINEL_GH_TOKEN_DO_NOT_LEAK';
const PACKAGES = 'SENTINEL_PACKAGES_TOKEN_DO_NOT_LEAK';
```

Test separately that:

1. `status()` reports configured booleans without calling/read-hooking token contents.
2. `read('github')` trims only surrounding whitespace and returns GH internally.
3. `read('packages')` returns PACKAGES internally.
4. missing file throws `GITHUB_CREDENTIAL_MISSING` with no token content.
5. whitespace-only file throws `GITHUB_CREDENTIAL_EMPTY`.
6. override paths are honored.
7. public status has no length/hash/prefix/suffix/token fields.

- [ ] **Step 6: Run credential tests and verify RED**

```powershell
npx vitest run tests/github-config-credentials.test.ts
```

Expected: FAIL because `GitHubCredentialProvider` does not exist.

- [ ] **Step 7: Implement `types.ts`, `errors.ts`, and `credentials.ts`**

Use `node:fs/promises` `access/readFile`. `status()` checks file existence only. `read()` performs the only secret read and returns a trimmed string internally. Error messages mention credential kind/path, never contents. Implement exact-value redaction helper replacing all loaded secret occurrences with `[REDACTED_GITHUB_CREDENTIAL]`.

- [ ] **Step 8: Verify GREEN and build**

```powershell
npx vitest run tests/config.test.ts tests/github-config-credentials.test.ts
npm run build
```

Expected: both commands exit 0.

- [ ] **Step 9: Commit milestone**

```powershell
git add src/config.ts src/github/types.ts src/github/errors.ts src/github/credentials.ts tests/config.test.ts tests/github-config-credentials.test.ts
git commit -m "feat: add github credential boundary"
```

---

### Task 2: Safe GitHub REST API Core

**Files:**
- Create: `src/github/safety.ts`
- Create: `src/github/api-service.ts`
- Create: `tests/github-api.test.ts`

**Interfaces:**
- Consumes: `GitHubConfig`, `GitHubCredentialProvider`.
- Produces:
  - `const GITHUB_DESTRUCTIVE_CONFIRMATION = 'CONFIRM_GITHUB_DESTRUCTIVE_OPERATION'`
  - `interface GitHubApiRequest { method; endpoint; query?; body?; headers?; credential?; }`
  - `interface GitHubApiResult { ok; status; method; endpoint; headers; data; }`
  - `class GitHubApiService { request(input: GitHubApiRequest): Promise<GitHubApiResult>; }`
  - `assertDestructiveConfirmation(required: boolean, value?: string): void`
  - endpoint/header guard helpers.

- [ ] **Step 1: Write failing REST tests**

Tests must cover:

1. relative `/user` resolves against configured API base URL;
2. same-origin absolute URL is accepted;
3. cross-origin absolute URL throws `GITHUB_ENDPOINT_NOT_ALLOWED` before fetch;
4. caller headers `authorization`, `proxy-authorization`, `cookie`, `set-cookie` are rejected before fetch;
5. request has exact `Authorization: Bearer <sentinel>`, `Accept`, API-version, and User-Agent internally;
6. GET query serialization omits null and stringifies number/boolean values predictably;
7. JSON body sets content type and serializes once;
8. 200 JSON, 204 empty, and text response normalization;
9. request ID/rate-limit/link-next metadata extraction;
10. 401→`GITHUB_API_AUTH_FAILED`, 403→`GITHUB_API_FORBIDDEN`, 404→`GITHUB_API_NOT_FOUND`, 422→`GITHUB_API_VALIDATION_FAILED`, 429 or rate exhaustion→`GITHUB_API_RATE_LIMITED`, other non-2xx→`GITHUB_API_ERROR`;
11. thrown network error containing sentinel is redacted;
12. redirect policy does not forward auth to a different origin: set `redirect: 'manual'` and treat external `Location` as `GITHUB_ENDPOINT_NOT_ALLOWED` rather than automatically following it.

- [ ] **Step 2: Verify REST RED**

```powershell
npx vitest run tests/github-api.test.ts
```

Expected: FAIL because API/safety services do not exist.

- [ ] **Step 3: Implement destructive/header/origin safety helpers**

Implement:

```ts
export function assertDestructiveConfirmation(required: boolean, value?: string): void
export function assertSafeCallerHeaders(headers: Record<string,string> | undefined): void
export function resolveGitHubApiEndpoint(baseUrl: string, endpoint: string): URL
```

`resolveGitHubApiEndpoint` compares `URL.origin` exactly. No credentials in endpoint URLs are allowed (`username/password` must be empty).

- [ ] **Step 4: Implement `GitHubApiService`**

Inject a `fetchImpl: typeof fetch = fetch` constructor dependency for deterministic tests. Load only the selected token per request. Use `AbortSignal.timeout(config.requestTimeoutMs)` or an equivalent AbortController. Set `redirect: 'manual'`. Normalize safe headers only. Parse body based on content type, falling back to text.

Errors include safe status/request ID/remediation fields, not complete arbitrary response headers. Redact all loaded secrets from upstream error/body previews before constructing errors.

- [ ] **Step 5: Verify REST GREEN and build**

```powershell
npx vitest run tests/github-api.test.ts tests/github-config-credentials.test.ts
npm run build
```

Expected: exit 0.

- [ ] **Step 6: Commit milestone**

```powershell
git add src/github/safety.ts src/github/api-service.ts tests/github-api.test.ts
git commit -m "feat: add safe github rest transport"
```

---

### Task 3: Authenticated HTTPS Git Transport Without Persisted Credentials

**Files:**
- Create: `src/github/process.ts`
- Create: `src/github/git-service.ts`
- Create: `tests/github-git.test.ts`

**Interfaces:**
- Produces:
  - `interface SpawnRequest { executable: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number; stdin?: string; redact?: string[]; }`
  - `interface SpawnResult { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; outputTruncated: boolean; }`
  - `runBoundedProcess(request: SpawnRequest): Promise<SpawnResult>`
  - `class GitHubGitService { status(); clone(); fetch(); pull(); push(); lsRemote(); remoteGetUrl(); remoteSetUrl(); }`
- Consumes: `WorkspacePolicy`, `GitHubConfig`, `GitHubCredentialProvider`.

- [ ] **Step 1: Write failing process/Git tests**

Use injected spawn/runner seams rather than real Git for argument-shape tests. Assert:

1. command args never contain sentinel token;
2. environment contains token only in the private `AGENT_CORE_GITHUB_ASKPASS_TOKEN` variable for the child lifetime;
3. `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS` points to a generated transient helper path, and `GIT_CONFIG_NOSYSTEM=1` is set;
4. helper source contains environment-variable reference but not sentinel literal;
5. canonical remote URL remains `https://github.com/owner/repo.git`;
6. clone destination/cwd must resolve within `WorkspacePolicy`;
7. `push(force: true)` without exact confirmation fails before runner invocation;
8. remote-set-url rejects token-bearing URLs and non-HTTPS GitHub URLs in v1;
9. auth stderr→`GITHUB_GIT_AUTH_FAILED`, non-fast-forward→`GITHUB_GIT_NON_FAST_FORWARD`, merge conflict→`GITHUB_GIT_CONFLICT`, other failure→`GITHUB_GIT_FAILED`;
10. returned stdout/stderr redact sentinel values;
11. transient askpass helper is deleted in `finally` for success and failure.

- [ ] **Step 2: Verify Git RED**

```powershell
npx vitest run tests/github-git.test.ts
```

Expected: FAIL because process/Git services do not exist.

- [ ] **Step 3: Implement bounded argument-array process runner**

Use `spawn(executable, args, { cwd, env, windowsHide: true, stdio: ['pipe','pipe','pipe'] })`. Reuse the existing 256 KiB output concept. Never stringify the environment or args into logs. Redact secret values from stdout/stderr before resolving or throwing.

- [ ] **Step 4: Implement GitHub Git service and transient askpass helper**

Create helper under `runtime/github/askpass/<uuid>.cmd` with static logic only:

```bat
@echo off
set "P=%~1"
echo %P% | findstr /I "username" >nul
if %errorlevel%==0 (echo x-access-token) else (echo %AGENT_CORE_GITHUB_ASKPASS_TOKEN%)
```

The token value is never written into the helper file. The service loads the token lazily, injects it through the child environment, runs `git.exe` with argument arrays, then removes the helper in `finally`.

For GitHub HTTPS remote validation, accept only `https://github.com/...` in v1. Never modify global Git config. Local `remote-set-url` is allowed only with safe canonical URLs.

- [ ] **Step 5: Verify Git GREEN and real local Git status**

```powershell
npx vitest run tests/github-git.test.ts
npm run build
git --version
```

Expected: focused tests/build exit 0; Git executable reports a version.

- [ ] **Step 6: Commit milestone**

```powershell
git add src/github/process.ts src/github/git-service.ts tests/github-git.test.ts
git commit -m "feat: add ephemeral github git transport"
```

---

### Task 4: GitHub Packages Boundary and Transient npm Authentication

**Files:**
- Create: `src/github/package-service.ts`
- Create: `tests/github-packages.test.ts`

**Interfaces:**
- Consumes: `GitHubApiService`, `GitHubCredentialProvider`, `WorkspacePolicy`, `GitHubConfig`, bounded process runner.
- Produces:
  - REST package list/version/delete/restore helpers using `credential: 'packages'`.
  - `npmView`, `npmPublish`, `npmInstall` using transient npm user config.

- [ ] **Step 1: Write failing package tests**

Assert:

1. package REST calls select the package credential;
2. user/org package endpoint generation uses encoded package name/type and bounded pagination;
3. delete version requires exact destructive confirmation before API invocation;
4. npm temp config uses `//npm.pkg.github.com/:_authToken=${token}` only inside the transient file;
5. token is absent from npm command args and returned output;
6. `NPM_CONFIG_USERCONFIG` points to the transient file for exactly one child invocation;
7. temp config is deleted in `finally` on success and failure;
8. npm auth failure→`GITHUB_PACKAGE_AUTH_FAILED`; other npm failure→`GITHUB_PACKAGE_FAILED`;
9. `npm_publish` requires a workspace-contained package directory;
10. `npm_install` requires a workspace-contained cwd and never mutates global npm config.

- [ ] **Step 2: Verify package RED**

```powershell
npx vitest run tests/github-packages.test.ts
```

Expected: FAIL because package service does not exist.

- [ ] **Step 3: Implement package service**

Use `packages-token.txt` only. Temporary npm config lives below `runtime/github/npm/<uuid>/.npmrc`, is mode-restricted where supported, and is removed recursively in `finally`. Spawn `npm` with argument arrays and `NPM_CONFIG_USERCONFIG` only. Do not use `npm config set`.

- [ ] **Step 4: Verify package GREEN and build**

```powershell
npx vitest run tests/github-packages.test.ts tests/github-api.test.ts
npm run build
```

Expected: exit 0.

- [ ] **Step 5: Commit milestone**

```powershell
git add src/github/package-service.ts tests/github-packages.test.ts
git commit -m "feat: add github packages transport"
```

---

### Task 5: GitHub Façade, Convenience Operations, MCP Tools, Routing, and Safe Audit

**Files:**
- Create: `src/github/service.ts`
- Create: `src/mcp/github-tools.ts`
- Modify: `src/runtime/services.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/memory/operational-audit.ts`
- Modify: `tests/mcp-toolset.test.ts`
- Modify: `tests/mcp-integration.test.ts`
- Create: `tests/github-mcp.test.ts`

**Interfaces:**
- `RuntimeServices.github: GitHubService`
- `createRuntimeServices(..., githubConfig?: GitHubConfig)` optional final constructor arg for tests/backward compatibility.
- `GITHUB_TOOL_NAMES = ['github_status','github_repo','github_git','github_issue','github_pr','github_actions','github_release','github_packages','github_api']`
- All except `github_status` require `routeContextId`.

- [ ] **Step 1: Write failing MCP discovery/routing tests**

Update existing discovery expectations and add `tests/github-mcp.test.ts` to prove:

1. all nine names appear in `tools/list`;
2. `github_status` has no `routeContextId` requirement and read-only annotations;
3. eight actionable tools require UUID `routeContextId` and route-required descriptions;
4. fake/missing route returns stable route error before GitHub service invocation;
5. wrong-principal route is rejected;
6. `agent_core_capabilities` contains `github.native_fabric` and all `tool.github_*` capabilities;
7. server tool count becomes exactly `52` (existing 43 + 9 GitHub tools).

- [ ] **Step 2: Verify MCP RED**

```powershell
npx vitest run tests/mcp-toolset.test.ts tests/mcp-integration.test.ts tests/github-mcp.test.ts
```

Expected: FAIL because GitHub tools are not registered.

- [ ] **Step 3: Implement `GitHubService` façade and convenience endpoint mappings**

Keep mappings explicit and testable. Examples:

```text
github_repo/get -> GET /repos/{owner}/{repo}
github_issue/create -> POST /repos/{owner}/{repo}/issues
github_pr/merge -> PUT /repos/{owner}/{repo}/pulls/{number}/merge
github_actions/dispatch -> POST /repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches
github_release/upload_asset -> uploads.github.com endpoint adapter handled explicitly, not generic github_api
github_packages/* -> GitHubPackageService
```

For v1, `github_api` remains restricted to configured API origin; upload asset is a dedicated service path because GitHub uses `uploads.github.com`. Do not weaken the generic origin rule to support uploads.

Convenience list operations accept `perPage` default 30 and `maxPages` default 10; pagination loops stop at `maxPages` and only follow same-origin next links.

- [ ] **Step 4: Implement safe routed MCP helper inside `github-tools.ts`**

Pattern:

```ts
validateOperationalRoute(runtime, key, routeContextId, toolName)
OperationalMemoryAudit.intended(route, toolName, safeAuditInput)
result = await operation()
OperationalMemoryAudit.succeeded(route, toolName, safeAuditInput, safeResultSummary)
```

Never pass full request body, custom headers, token paths, child env, npm config, or arbitrary GitHub response data to audit. For failure, pass a `GitHubFabricError` whose message is already redacted.

- [ ] **Step 5: Implement schemas/dispatch for each MCP tool**

Schemas expose only fields needed by the spec. `github_api.headers` is allowed but `GitHubApiService` enforces credential-header rejection. Destructive operations call `assertDestructiveConfirmation` before service invocation. `github_status` calls only local status methods; it must not read credential contents or invoke fetch/Git network operations.

- [ ] **Step 6: Extend safe audit key allowlist**

Add only scalar keys such as:

```text
operation, owner, repo, method, endpoint, remote, ref, branch, workflow, issueNumber, pullNumber, releaseId, assetPath, packageType, packageName, packageVersionId
```

Do not add `body`, `headers`, `token`, `credentialContents`, `env`, `npmrc`, or response `data`.

- [ ] **Step 7: Verify MCP GREEN and build**

```powershell
npx vitest run tests/mcp-toolset.test.ts tests/mcp-integration.test.ts tests/github-mcp.test.ts
npm run build
```

Expected: exit 0 and exact 52-tool assertion passes.

- [ ] **Step 8: Commit milestone**

```powershell
git add src/github/service.ts src/mcp/github-tools.ts src/runtime/services.ts src/mcp/server.ts src/memory/operational-audit.ts tests/mcp-toolset.test.ts tests/mcp-integration.test.ts tests/github-mcp.test.ts
git commit -m "feat: expose native github mcp tools"
```

---

### Task 6: Native Plugin Skill and Stable Release Packaging

**Files:**
- Create: `plugin/agent-core/skills/agent-core-github/SKILL.md`
- Modify: `plugin/agent-core/README.md`
- Modify: `scripts/release/build-release.ps1`
- Modify: `tests/plugin-package.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Stable tracked plugin metadata lists both:
  - `agent-core-capability-router`
  - `agent-core-github`

- [ ] **Step 1: Write failing package/release tests**

Extend `tests/plugin-package.test.ts` (and release-specific test if existing) to assert:

1. generated/stable plugin contains both skill directories;
2. `agent-core-package.json.skills` contains both names;
3. stable release packaging source remains tracked core only;
4. no `secrets/`, `gh-token.txt`, `packages-token.txt`, sentinel token pattern, or runtime npm/askpass credential material is present in staged package file lists/text files.

- [ ] **Step 2: Verify plugin/release RED**

```powershell
npx vitest run tests/plugin-package.test.ts
```

Expected: FAIL because second native tracked skill is absent.

- [ ] **Step 3: Add `agent-core-github` native skill**

The skill instructs callers to:

- use convenience GitHub tools first;
- use `github_api` as REST escape hatch;
- use `github_git` for authenticated HTTPS transport;
- use package credential only through package operations;
- never request/echo token values;
- supply destructive confirmation only when the user explicitly intends the guarded action.

No credential content/path outside documented relative defaults is embedded.

- [ ] **Step 4: Update stable release builder and plugin docs**

Copy both tracked skills into plugin staging, update metadata description/skills array, preserve existing explicit exclusions. Do not add `secrets` to runtime allowlist.

- [ ] **Step 5: Update changelog**

Add a concise Native GitHub Fabric entry without changing `package.json` version in this feature milestone.

- [ ] **Step 6: Verify plugin/release GREEN**

```powershell
npx vitest run tests/plugin-package.test.ts
npm run build:plugin
npm run build
```

Expected: exit 0. Inspect generated plugin metadata only; do not expose secret files.

- [ ] **Step 7: Commit milestone**

```powershell
git add plugin/agent-core/skills/agent-core-github/SKILL.md plugin/agent-core/README.md scripts/release/build-release.ps1 tests/plugin-package.test.ts CHANGELOG.md
git commit -m "feat: package native github skill"
```

---

### Task 7: Secret-Leakage, Destructive-Guard, and Regression Acceptance

**Files:**
- Create: `tests/github-secret-leakage.test.ts`
- Modify any GitHub production files only if the RED leakage tests reveal a real defect.

**Interfaces:**
- Test sentinel values:
  - `SENTINEL_GH_TOKEN_DO_NOT_LEAK_8675309`
  - `SENTINEL_PACKAGES_TOKEN_DO_NOT_LEAK_424242`

- [ ] **Step 1: Write failing end-to-end leakage tests**

Create temporary Agent Core root, temporary credential files, memory/audit directories, fake fetch/process seams, and inspect all produced observable surfaces. Assert sentinels are absent from:

1. MCP `content`/structured results;
2. thrown errors;
3. deterministic memory event/search text and metadata reachable through test APIs;
4. file audit logs;
5. process argument arrays captured by test runner;
6. local `.git/config` after mocked/fixture remote operations;
7. generated askpass helper file contents;
8. filesystem after npm operation (`.npmrc` temp removed);
9. stable release staging/plugin package text/file list.

Also prove destructive operation attempts without exact confirmation invoke neither fetch nor process runner.

- [ ] **Step 2: Verify leakage RED if a leak exists; otherwise introduce a targeted regression assertion against a known pre-fix seam**

Run:

```powershell
npx vitest run tests/github-secret-leakage.test.ts
```

If the initial test passes because earlier code already satisfies all constraints, validate the regression test itself by temporarily substituting a test-only leaking dependency seam and prove the assertion fails; do not weaken the production test.

- [ ] **Step 3: Fix any leakage defects minimally**

No new capability is added in this step; only redaction/audit/process/temp-file defects revealed by the tests are fixed.

- [ ] **Step 4: Run focused GitHub suite**

```powershell
npx vitest run tests/github-config-credentials.test.ts tests/github-api.test.ts tests/github-git.test.ts tests/github-packages.test.ts tests/github-mcp.test.ts tests/github-secret-leakage.test.ts
```

Expected: all pass.

- [ ] **Step 5: Run complete deterministic verification**

```powershell
npm run verify
```

Expected: brand check, TypeScript build, and full Vitest suite all exit 0.

- [ ] **Step 6: Run release verification**

```powershell
npm run verify:release
```

Expected: exit 0. If this fails due to an unrelated pre-existing environment constraint, report exact evidence and do not claim release verification passed.

- [ ] **Step 7: Review working tree before commit**

```powershell
git status --short
git diff --check
git diff --stat HEAD
```

Expected: only planned source/test/docs changes plus pre-existing untracked `stable-release/`; no secret/runtime files staged.

- [ ] **Step 8: Commit security/regression milestone**

```powershell
git add tests/github-secret-leakage.test.ts src/github src/mcp/github-tools.ts src/memory/operational-audit.ts
git diff --cached --name-only
git commit -m "test: harden github fabric secret boundaries"
```

Only commit files actually changed by this milestone; do not stage unrelated paths.

---

### Task 8: Read-Only Live Credential Acceptance and Final Integration Evidence

**Files:**
- Create: `tests/github-live.acceptance.test.ts` or `scripts/github-live-acceptance.mjs` (prefer test file if it can be opt-in without reading tokens during normal tests).
- Modify: `README.md` and/or `docs/README.md` only after live acceptance clarifies operator usage.

**Interfaces:**
- Opt-in environment flag: `AGENT_CORE_GITHUB_LIVE_ACCEPTANCE=1`.
- Live output may include authenticated username/login, safe repository name/visibility, HTTP status, package access status, and Git ref count/SHA metadata; never token values/scopes inferred beyond observed success/failure.

- [ ] **Step 1: Write live acceptance harness with normal-test skip**

The harness reads real secret files only when `AGENT_CORE_GITHUB_LIVE_ACCEPTANCE=1`. It performs only:

1. general token: `GET /user`;
2. general token: `GET /repos/rendevouz999/Agent-Core`;
3. package token: `GET /user/packages/npm` with bounded `per_page=1` (or equivalent authenticated package metadata endpoint); treat 403/404 as scope/access evidence, not as token-value output;
4. general token: authenticated `git ls-remote https://github.com/rendevouz999/Agent-Core.git` through `GitHubGitService` askpass path.

- [ ] **Step 2: Run deterministic test proving default skip**

```powershell
npx vitest run tests/github-live.acceptance.test.ts
```

Expected: suite reports skipped live acceptance without reading secret contents.

- [ ] **Step 3: Run live acceptance explicitly**

```powershell
$env:AGENT_CORE_GITHUB_LIVE_ACCEPTANCE='1'
npx vitest run tests/github-live.acceptance.test.ts
Remove-Item Env:AGENT_CORE_GITHUB_LIVE_ACCEPTANCE
```

Expected: `/user`, repository API, and `git ls-remote` authenticate if the general token has the required access. Package probe reports success or a structured permission/access limitation; it must not cause the general GitHub Fabric acceptance to fabricate package permissions.

- [ ] **Step 4: Add operator documentation**

Document only:

```text
secrets/github/gh-token.txt
secrets/github/packages-token.txt
```

plus environment override names and example natural-language GitHub tasks. Explicitly state no `gh auth login` is required and secrets remain local/excluded from release artifacts.

- [ ] **Step 5: Re-run final verification after docs/harness**

```powershell
npm run verify
npm run verify:release
git diff --check
git status --short
```

Expected: deterministic verification passes; status shows only intended tracked changes/commits plus untouched untracked `stable-release/`.

- [ ] **Step 6: Commit final acceptance/docs milestone**

```powershell
git add tests/github-live.acceptance.test.ts README.md docs/README.md
git diff --cached --name-only
git commit -m "docs: document native github fabric"
```

Stage only files that actually changed.

- [ ] **Step 7: Final evidence report**

Report:

- current HEAD SHA;
- `git status --short --branch`;
- total MCP tool count and GitHub tool names;
- focused GitHub suite result;
- full `npm run verify` result;
- `npm run verify:release` result;
- safe live probe outcomes for general token, package token, repository access, and Git transport;
- confirmation that no token value was printed or persisted;
- any permission limitation observed from the supplied tokens without overstating capabilities.

Do not push to GitHub until the Native GitHub Fabric itself has passed read-only live acceptance; after acceptance, a separate explicit publication action may use the new Fabric.
