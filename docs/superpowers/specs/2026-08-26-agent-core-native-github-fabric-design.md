# Agent Core Native GitHub Fabric — Design Specification

**Date:** 2026-08-26
**Status:** Approved architecture, pre-implementation
**Owner:** Agent Core

## 1. Purpose

Add a first-class, native GitHub subsystem to Agent Core so authenticated ChatGPT/Agent Core sessions can perform relevant GitHub work without interactive GitHub login, without `gh auth login`, without Windows Credential Manager, and without persisting GitHub credentials outside the project secret files.

The subsystem must use:

- Node.js `fetch()` for GitHub REST API operations;
- the installed `git.exe` for Git repository transport operations;
- lazy runtime credential reads from project-local secret files;
- Agent Core route contexts, principal binding, audit, memory, continuity, and execution boundaries for all actionable operations.

The design intentionally does **not** depend on the GitHub CLI (`gh`).

## 2. Approved credential sources

Default credential paths are resolved relative to the Agent Core project root, never hardcoded to a drive letter:

```text
<Agent-Core>/secrets/github/gh-token.txt
<Agent-Core>/secrets/github/packages-token.txt
```

Current workstation locations are:

```text
E:\Projects\Agent-Core\secrets\github\gh-token.txt
E:\Projects\Agent-Core\secrets\github\packages-token.txt
```

Environment overrides:

```text
AGENT_CORE_GITHUB_TOKEN_FILE
AGENT_CORE_GITHUB_PACKAGES_TOKEN_FILE
```

The service must read token contents only at the moment an operation requires them. Tokens must not be cached to disk, copied into runtime state, committed to Git, packaged into releases, returned in MCP responses, or emitted to logs.

## 3. External GitHub contracts

### 3.1 REST API

GitHub REST requests use:

```text
Authorization: Bearer <token>
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2026-03-10
User-Agent: Agent-Core/<version>
```

The API version is explicit and centralized in one constant/configurable service boundary so future GitHub API-version upgrades require one intentional change rather than silent behavior drift.

Base URL defaults to:

```text
https://api.github.com
```

The first release targets GitHub.com. The internal service boundary should allow a future GitHub Enterprise REST base URL without redesigning MCP tools.

### 3.2 Git transport

Authenticated HTTPS Git operations use the installed `git.exe` and keep canonical remotes in normal form:

```text
https://github.com/<owner>/<repo>.git
```

Tokens must never be embedded in a remote URL such as:

```text
https://TOKEN@github.com/...
```

Git credentials are injected only for the lifetime of the child process through an ephemeral credential-helper mechanism controlled by Agent Core. The helper receives the token through an inherited environment variable or private standard-input channel and must never persist it.

The helper must not call `git credential approve`, `git credential-store`, Windows Credential Manager, or any global credential helper.

## 4. Architectural shape

```text
Agent Core MCP
    |
    +-- capability_route / principal-bound route context
    |
    +-- GitHub MCP Tools
            |
            +-- GitHubCredentialProvider
            |      +-- gh-token.txt
            |      +-- packages-token.txt
            |
            +-- GitHubApiService
            |      +-- Node fetch()
            |      +-- response normalization
            |      +-- rate-limit metadata
            |      +-- safe error redaction
            |
            +-- GitHubGitService
            |      +-- git.exe
            |      +-- ephemeral credential injection
            |      +-- workspace-bound cwd/path validation
            |
            +-- GitHubPackageService
                   +-- REST package metadata/management
                   +-- GitHub npm registry operations for Agent Core packages
```

Runtime integration:

```text
RuntimeServices
    +-- github: GitHubService
```

MCP integration:

```text
createAgentCoreMcpServer()
    +-- registerGitHubTools(server, runtime, key)
```

The existing operational route guard/audit pattern is reused rather than bypassed.

## 5. Components

### 5.1 GitHubCredentialProvider

Responsibilities:

1. Resolve default and override credential paths.
2. Verify the requested credential file exists.
3. Read UTF-8 text lazily.
4. Trim surrounding whitespace/newline only.
5. Reject empty tokens.
6. Return token only to internal GitHub services.
7. Never expose token through a public status/result object.
8. Provide redaction helpers based on values loaded in the current call.

Public metadata may include only:

```ts
interface GitHubCredentialStatus {
  githubTokenConfigured: boolean;
  packagesTokenConfigured: boolean;
  githubTokenPath: string;
  packagesTokenPath: string;
}
```

No token length, prefix, suffix, hash, or fingerprint is required in public output.

### 5.2 GitHubApiService

Responsibilities:

- Build authenticated REST requests.
- Normalize relative endpoints such as `/repos/owner/repo`.
- Restrict arbitrary URLs to the configured GitHub API origin.
- Apply timeout/AbortController bounds.
- Parse JSON, text, and empty-body responses.
- Preserve useful status, selected headers, pagination links, request ID, rate-limit fields, and response body.
- Redact tokens from upstream exception/error strings before returning or auditing them.
- Reject attempts to provide caller-controlled `Authorization`, `Proxy-Authorization`, `Cookie`, or other credential-bearing headers.

Normalized result:

```ts
interface GitHubApiResult {
  ok: boolean;
  status: number;
  method: string;
  endpoint: string;
  headers: {
    requestId?: string;
    rateLimitLimit?: number;
    rateLimitRemaining?: number;
    rateLimitReset?: number;
    next?: string;
  };
  data: unknown;
}
```

### 5.3 GitHubGitService

Responsibilities:

- Locate Git executable through normal executable resolution.
- Restrict local working paths through `WorkspacePolicy`.
- Run supported Git operations without token-bearing command arguments.
- Inject ephemeral HTTPS credentials.
- Bound execution time and output.
- Sanitize stdout/stderr before returning or auditing.
- Detect authentication failures distinctly from Git merge/conflict/non-fast-forward failures.

Supported operation families in v1:

```text
clone
fetch
pull
push
ls-remote
remote-get-url
remote-set-url
```

Local-only Git commands remain available through the existing Agent Core command/execution systems; this service exists specifically for authenticated GitHub transport and GitHub-specific safety behavior.

`force` push is supported only through an explicit destructive confirmation field.

### 5.4 GitHubPackageService

The package token has a separate credential boundary from the general GitHub token.

Responsibilities:

- REST package listing, metadata, versions, delete, and restore where GitHub supports the endpoint.
- GitHub Packages npm registry operations relevant to Agent Core packages using the packages token.
- Never write a persistent `.npmrc` containing the token.
- For npm commands, create a temporary user-config file under Agent Core runtime, use it for one child process through `NPM_CONFIG_USERCONFIG`, then remove it in `finally`.
- The temporary npm config must not enter Git, stable release artifacts, logs, or audit payloads.

Initial npm operations:

```text
view
publish
install
```

Package deletion remains a REST operation and is destructive-gated.

The architecture leaves room for future registry adapters (container, NuGet, Maven, RubyGems), but v1 does not claim registry-publish support for package ecosystems that are not implemented.

## 6. MCP tool surface

All tools except `github_status` require a valid `routeContextId` from `capability_route`.

### 6.1 `github_status`

Read-only direct diagnostic tool.

Returns only safe state:

```json
{
  "configured": true,
  "githubTokenConfigured": true,
  "packagesTokenConfigured": true,
  "gitAvailable": true,
  "gitVersion": "...",
  "apiBaseUrl": "https://api.github.com",
  "apiVersion": "2026-03-10"
}
```

It must not authenticate or consume rate limit merely to report local configuration.

### 6.2 `github_repo`

Operation enum:

```text
get
list_for_authenticated_user
create_for_authenticated_user
create_in_org
update
archive
unarchive
fork
star
unstar
```

Repo deletion is intentionally **not** hidden inside `update`; it is a distinct `delete` operation requiring destructive confirmation.

### 6.3 `github_git`

Operation enum:

```text
clone
fetch
pull
push
ls_remote
remote_get_url
remote_set_url
```

Inputs identify repository/local path/ref/remote as appropriate. `push` supports `force` only when the destructive-confirmation contract is satisfied.

### 6.4 `github_issue`

Operation enum:

```text
get
list
create
update
comment
close
reopen
lock
unlock
```

### 6.5 `github_pr`

Operation enum:

```text
get
list
create
update
comment
review
merge
close
reopen
files
commits
checks
```

Merge is considered destructive/high-impact and requires explicit confirmation because it changes the target branch.

### 6.6 `github_actions`

Operation enum:

```text
list_workflows
get_workflow
list_runs
get_run
dispatch
rerun
rerun_failed
cancel
artifacts
logs_url
```

No attempt is made to execute downloaded artifacts automatically.

### 6.7 `github_release`

Operation enum:

```text
get
list
create
update
publish
upload_asset
delete_asset
delete_release
```

Deletion operations require destructive confirmation.

Binary asset upload accepts a local workspace path; Agent Core reads/streams that file internally rather than encoding it into the MCP prompt.

### 6.8 `github_packages`

Operation enum:

```text
list
get_versions
delete_version
restore_version
npm_view
npm_publish
npm_install
```

Package deletion requires destructive confirmation.

### 6.9 `github_api`

Generic REST escape hatch for GitHub functionality not yet represented by a convenience tool.

Inputs:

```ts
{
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  endpoint: string;
  query?: Record<string, string | number | boolean | null>;
  body?: unknown;
  headers?: Record<string, string>; // safe allowlist only
  credential?: 'github' | 'packages';
  destructiveConfirmation?: string;
  routeContextId: string;
}
```

Rules:

- Endpoint must resolve inside configured GitHub REST API origin.
- General token is default.
- Package token can be selected explicitly for package endpoints.
- Caller cannot override authentication headers.
- `DELETE` always requires destructive confirmation.
- High-impact POST/PATCH endpoints known to merge, archive, cancel, dispatch, transfer, or mutate access controls can be flagged through the destructive classifier even when the HTTP verb is not DELETE.

This tool is the forward-compatibility layer: a new GitHub REST endpoint should be usable without adding a new MCP tool, provided current credentials permit it.

## 7. Destructive-operation contract

Agent Core must support powerful GitHub administration without making accidental irreversible operations easy.

Destructive actions require a literal confirmation token in the MCP input:

```text
CONFIRM_GITHUB_DESTRUCTIVE_OPERATION
```

Examples:

- delete repository;
- force push;
- delete branch/reference through generic API;
- merge pull request;
- delete release;
- delete release asset;
- delete package/package version;
- repository transfer;
- destructive access-control changes classified by the generic API guard.

Missing or mismatched confirmation rejects the operation before network/process side effects.

This confirmation is separate from `routeContextId`; route authorization alone is not sufficient for destructive GitHub actions.

## 8. Audit and memory rules

GitHub tools use the same principal-bound route validation as Agent Core operational tools.

Audit input may include:

```text
tool name
operation
owner/repo
HTTP method
REST endpoint without query secrets
local path
remote name
branch/ref
asset path
status/result summary
```

Audit input must never include:

```text
token value
Authorization header
credential helper payload
npm auth line
secret-file contents
full environment map
body fields explicitly classified as secrets
```

GitHub responses can themselves contain secrets if a user stores credentials in issue text, repository variables, workflow data, or other resources. Generic response logging must therefore be bounded and conservative: operational audit should record summaries/status rather than dumping arbitrary complete response bodies into deterministic memory.

## 9. Error model

Use stable internal error codes so callers can distinguish remediation paths:

```text
GITHUB_CREDENTIAL_MISSING
GITHUB_CREDENTIAL_EMPTY
GITHUB_API_AUTH_FAILED
GITHUB_API_FORBIDDEN
GITHUB_API_NOT_FOUND
GITHUB_API_RATE_LIMITED
GITHUB_API_VALIDATION_FAILED
GITHUB_API_ERROR
GITHUB_GIT_NOT_FOUND
GITHUB_GIT_AUTH_FAILED
GITHUB_GIT_NON_FAST_FORWARD
GITHUB_GIT_CONFLICT
GITHUB_GIT_FAILED
GITHUB_PACKAGE_AUTH_FAILED
GITHUB_PACKAGE_FAILED
GITHUB_DESTRUCTIVE_CONFIRMATION_REQUIRED
GITHUB_ENDPOINT_NOT_ALLOWED
```

Returned errors may preserve GitHub request IDs and safe remediation text, but never credentials.

GitHub may intentionally return 404 for resources the token cannot access; the service must not claim a resource definitively does not exist when the status could represent insufficient permissions.

## 10. Rate limits and pagination

The API service exposes rate-limit metadata from GitHub response headers.

Convenience list tools should support bounded pagination with defaults and maximums rather than unbounded crawling.

Suggested default:

```text
perPage = 30
maxPages = 10
```

The generic `github_api` tool performs one request per call and returns pagination-link metadata. This avoids hidden high-volume behavior.

Agent Core does not automatically sleep/retry until reset for primary/secondary rate limits. It returns a structured rate-limit error so an explicit retry/automation can decide what to do.

## 11. Security requirements

### 11.1 Secret non-disclosure

Tests must use sentinel fake tokens and prove sentinel values are absent from:

- MCP tool results;
- exception messages;
- audit files;
- deterministic memory events created by GitHub operations;
- process command lines;
- Git remote URLs;
- `.git/config`;
- npm config left on disk after completion;
- stable release staging/assets.

### 11.2 Filesystem permissions

Agent Core will not rewrite the user's secret files. Existing filesystem ACLs remain the operator's responsibility.

The service only requires read permission to the two credential files.

### 11.3 SSRF/origin boundary

`github_api.endpoint` accepts a relative API endpoint, or a full URL only if its origin exactly matches the configured GitHub API origin.

Redirect handling must not forward `Authorization` credentials to a different origin.

### 11.4 Input validation

Repository identifiers use separate `owner` and `repo` fields where practical.

Git refs, release tags, workflow IDs, package names, and local paths are treated as data; they must not be concatenated into shell command strings. Git/npm process execution uses argument arrays at the service boundary where possible.

## 12. Configuration

Add:

```ts
interface GitHubConfig {
  enabled: boolean;
  apiBaseUrl: string;
  apiVersion: string;
  tokenFile: string;
  packagesTokenFile: string;
  requestTimeoutMs: number;
  gitTimeoutMs: number;
}
```

Environment variables:

```text
AGENT_CORE_GITHUB_ENABLED=true
AGENT_CORE_GITHUB_API_BASE_URL=https://api.github.com
AGENT_CORE_GITHUB_API_VERSION=2026-03-10
AGENT_CORE_GITHUB_TOKEN_FILE=<root>/secrets/github/gh-token.txt
AGENT_CORE_GITHUB_PACKAGES_TOKEN_FILE=<root>/secrets/github/packages-token.txt
AGENT_CORE_GITHUB_REQUEST_TIMEOUT_MS=30000
AGENT_CORE_GITHUB_GIT_TIMEOUT_MS=120000
```

Defaults are resolved from Agent Core `baseDir`, preserving portability across drive letters/machines.

## 13. Plugin integration

Add tracked native skill:

```text
plugin/agent-core/skills/agent-core-github/SKILL.md
```

Purpose:

- tell Agent Core/ChatGPT when to use GitHub-native tools rather than raw shell;
- prefer convenience tools for known workflows;
- use `github_api` only as an escape hatch;
- use `github_git` for authenticated HTTPS repository transport;
- use the package credential only for package operations;
- never request, quote, echo, or expose token contents;
- require destructive confirmation for guarded operations.

Stable plugin release metadata must list both tracked native skills:

```text
agent-core-capability-router
agent-core-github
```

No credential file is ever included in the plugin package.

## 14. Release integration

The stable release runtime allowlist already includes `src`, `dist`, `scripts`, and tracked plugin skills while explicitly excluding secrets/runtime state.

Required changes:

- include `plugin/agent-core/skills/agent-core-github` in tracked plugin packaging;
- update plugin metadata description/tool capability text;
- keep `secrets` excluded;
- add release checks proving no token sentinel appears in staged artifacts.

The current local `stable-release` directory is not the source of truth for implementation. Source changes occur in the primary repository; a future release build regenerates release artifacts.

## 15. Test strategy

TDD is required.

### Unit tests

1. Credential path/default/override resolution.
2. Lazy token read and empty-token rejection.
3. API header construction with mocked `fetch`.
4. API-version and Accept headers.
5. Header injection rejection.
6. Endpoint-origin enforcement.
7. Response/rate-limit normalization.
8. Token redaction from thrown errors.
9. Git argument generation without secret values.
10. Destructive confirmation classifier.
11. Temporary npm config lifecycle and cleanup.

### MCP integration tests

1. GitHub tools appear in `tools/list`.
2. `github_status` is direct/read-only.
3. All actionable GitHub tools require route context.
4. Missing/expired/wrong-principal route is rejected before side effects.
5. Destructive operations reject without exact confirmation.
6. Representative mocked repo/issue/PR/action/release/package/API calls map correctly.
7. Audit contains safe metadata but no sentinel token.

### Local integration tests

Using fake local HTTP and Git fixtures where possible:

- authenticated fetch behavior without external GitHub dependency;
- credential helper interaction with a test remote/credential request;
- token does not enter `.git/config` or process arguments.

### Live credential acceptance

After all deterministic tests pass, perform minimal read-only live probes using the user's configured secret files:

1. authenticate `GET /user` using `gh-token.txt`;
2. authenticate/list appropriate package metadata using `packages-token.txt` where token permissions permit;
3. verify a read-only repository API call for the Agent Core repository;
4. perform `git ls-remote` against the Agent Core HTTPS remote through the ephemeral credential path.

Live acceptance output reports only username/repository-safe metadata and capability/permission success/failure; token values remain undisclosed.

No destructive live operation is part of acceptance.

## 16. Capability claims

After implementation, Agent Core may claim:

- no interactive GitHub login required after token files are provisioned;
- no dependency on GitHub CLI;
- native REST API access for broad GitHub administration according to token permissions;
- authenticated HTTPS Git repository transport;
- issue/PR/Actions/release/package convenience workflows;
- generic REST escape hatch for future/unwrapped GitHub endpoints;
- package-token separation;
- route/audit/memory integration;
- portable token-file resolution.

Agent Core must **not** claim:

- permissions the supplied tokens do not actually have;
- support for undocumented GitHub endpoints;
- registry publishing for every GitHub Packages ecosystem in v1;
- GraphQL support in v1;
- GitHub Enterprise support until its base-URL behavior is tested and documented.

## 17. Non-goals for v1

- installing or using GitHub CLI;
- OAuth browser/device login to GitHub;
- credential-manager integration;
- persisting tokens in Git configuration;
- GitHub GraphQL API;
- automatic organization-wide destructive administration;
- SSH key management;
- automated secret rotation on GitHub;
- broad package-registry adapters beyond npm publishing/install plus REST package management.

These can be future extensions without changing the core credential/API/tool boundaries defined here.

## 18. Success criteria

The feature is complete when all of the following are true:

1. Agent Core starts normally with GitHub Fabric enabled by default when configuration is valid.
2. Absence of token files does not crash Agent Core startup; GitHub tools return a structured credential-missing error only when credentialed work is requested.
3. `github_status` reports configuration without reading/exposing token values.
4. All actionable GitHub tools are principal-bound and route-gated.
5. GitHub REST requests authenticate from `gh-token.txt` without `gh auth login`.
6. Package operations authenticate from `packages-token.txt`.
7. Authenticated Git clone/fetch/pull/push/ls-remote work without persisting credentials.
8. General GitHub REST operations are reachable through `github_api` according to token permissions.
9. Destructive operations require exact explicit confirmation.
10. Sentinel-token leakage tests pass across results, audit, memory, Git config, command lines, temporary npm config lifecycle, and release staging.
11. The native `agent-core-github` plugin skill is tracked and included in stable plugin packaging.
12. Read-only live probes validate both credential channels as far as their actual scopes permit, without revealing token contents.
