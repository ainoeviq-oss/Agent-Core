# Native GitHub Fabric

Native GitHub Fabric gives Agent Core a first-class GitHub transport without `gh auth login`, a credential manager, or tokens embedded in repository URLs, command arguments, source files, logs, memory, or release packages.

The connected model decides what GitHub action is appropriate. Agent Core applies route policy, workspace policy, credential isolation, destructive-operation gates, transport bounds, redaction, and factual result reporting.

## Absolute GitHub Actions / CI ban

GitHub Actions is permanently disabled for the Agent Core repository. CI execution is not an allowed release path, verification fallback, secondary check, or recovery mechanism. The `github_actions` tool must never be invoked for this repository, including read/list, dispatch, rerun, cancel, or workflow-management operations.

Local verification is the execution authority. Once a local release gate has passed and the build has been declared stable, that evidence must not be repeated on GitHub-hosted runners. Release publication is direct: local package construction and checksum verification, authenticated Git/tag push, GitHub Package publication through the dedicated package credential, GitHub Release creation, asset upload, and final remote metadata/equality checks.

The repository-side GitHub Actions setting is disabled, and tracked workflow files intentionally contain no executable workflow definition. Re-enabling Actions or adding an executable workflow is a policy violation unless this repository policy is explicitly replaced by the operator.

## MCP surface

The GitHub capability adds nine MCP tools to the Agent Core tool surface:

- `github_status` — direct, read-only local status for Git availability and credential-file configuration.
- `github_repo` — repository read/create/update/archive/transfer/delete operations.
- `github_git` — clone/fetch/pull/push/ls-remote and local remote URL operations.
- `github_issue` — issue list/get/create/update/close/comment operations.
- `github_pr` — pull-request list/get/create/update/review/comment/merge operations.
- `github_actions` — policy-disabled for this repository; do not invoke it for read, dispatch, cancellation, rerun, or any other workflow operation.
- `github_release` — release list/get/create/edit/delete and asset upload operations.
- `github_packages` — GitHub Packages REST and npm operations.
- `github_api` — bounded generic GitHub REST access for endpoints not yet represented by a higher-level tool.

`github_status` is direct and read-only. The other GitHub tools are route-bound and must use a current principal/project route from `capability_route`. An atomic read-only route cannot be reused for mutation through a combined read/write GitHub tool.

## Credentials

Agent Core keeps GitHub credentials in two independent local files:

```text
secrets/github/gh-token.txt
secrets/github/packages-token.txt
```

`gh-token.txt` is the general GitHub credential boundary for GitHub REST and authenticated HTTPS Git operations. `packages-token.txt` is a separate GitHub Packages/npm credential boundary. Agent Core reads either token lazily only when an operation requires it; status checks only verify whether the files exist.

The token files are operator-managed secrets. They are excluded from Git and stable release artifacts. Do not copy their values into `.env`, Git remotes, source files, scripts, issue text, prompts, logs, or documentation.

### General GitHub credential

For GitHub REST, prefer a fine-grained personal access token where the required endpoints support it, grant access only to the required repositories, and select the least repository/account permissions needed by the intended operations. GitHub publishes endpoint-specific fine-grained permission requirements and can expose accepted permissions through the `X-Accepted-GitHub-Permissions` response header.

Read-only repository metadata endpoints such as repository inspection use repository metadata access. Write operations need the additional endpoint-specific permission required by GitHub. Authenticated HTTPS Git also uses a personal access token instead of an account password; the token must have access appropriate to the repository and Git operation.

Official references:

- https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens
- https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
- https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-authentication-to-github

### GitHub Packages credential

GitHub's npm registry documentation currently specifies authentication with a **personal access token (classic)**. Keep that credential in `packages-token.txt`, separate from the general GitHub token. Read/install scenarios need at least the `read:packages` scope; publishing or destructive package operations require the additional scopes/permissions GitHub documents for those actions.

Official reference:

- https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry

## REST transport

Default REST endpoint:

```text
https://api.github.com
```

Agent Core sends:

```text
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2026-03-10
User-Agent: Agent-Core/0.5.4
```

The API version is explicit rather than relying on GitHub's default. It can be overridden with `AGENT_CORE_GITHUB_API_VERSION` when Agent Core is intentionally moved to a different supported GitHub API version.

Official API-version reference:

- https://docs.github.com/en/rest/about-the-rest-api/api-versions

Caller-supplied authentication headers are rejected. REST endpoints must stay on the configured API origin, cross-origin redirects are not followed, requests are bounded by timeout, and error output is redacted before it can cross the GitHub service boundary.

## HTTPS Git transport

Authenticated Git operations use the installed `git.exe` directly. Agent Core does not call `gh`, does not run `gh auth login`, and does not store credentials in Git config or Windows Credential Manager.

For each authenticated Git process Agent Core:

1. creates a short-lived askpass helper under `runtime/github/askpass`;
2. injects the token only into the child-process environment;
3. uses a token-free canonical remote such as `https://github.com/OWNER/REPOSITORY.git`;
4. disables terminal credential prompting;
5. redacts child output;
6. deletes the askpass helper in `finally`, including failure paths.

The helper source contains no token value. Tokens are never written into remote URLs or Git command arguments.

## GitHub Packages and npm transport

Package REST operations always select the separate `packages` credential. npm operations create one temporary `.npmrc` below `runtime/github/npm`, point that single child process at it using `NPM_CONFIG_USERCONFIG`, redact process output, and remove the temporary directory in `finally`.

Agent Core does not modify the user's global npm configuration for GitHub authentication.

## Destructive-operation gates

High-impact GitHub mutations require the exact Agent Core destructive confirmation before side effects begin. This includes operations such as force push, repository delete/archive/transfer, pull-request merge, release delete, package-version delete, and generic non-GET `github_api` calls where the tool cannot infer a narrower safe semantic contract. GitHub Actions operations are not covered by this gate because they are forbidden entirely for this repository.

The gate runs before credential reads or process/network side effects whenever possible.

## Rotation and machine migration

The credential boundary is file-based and lazy. To rotate a token, replace the content of the corresponding local token file and leave source/configuration unchanged. No interactive login is required.

When moving Agent Core to another machine, copy the project without secrets, create the same `secrets/github` directory locally, place the new machine's operator-approved credentials in the two files, and keep the files outside Git/release artifacts.

## Configuration overrides

Defaults are rooted at the Agent Core directory. Optional environment overrides are available for controlled deployments:

```text
AGENT_CORE_GITHUB_ENABLED
AGENT_CORE_GITHUB_API_BASE_URL
AGENT_CORE_GITHUB_API_VERSION
AGENT_CORE_GITHUB_TOKEN_FILE
AGENT_CORE_GITHUB_PACKAGES_TOKEN_FILE
AGENT_CORE_GITHUB_REQUEST_TIMEOUT_MS
AGENT_CORE_GITHUB_GIT_TIMEOUT_MS
```

Do not put token values in these variables. The token-file overrides are paths, not credential values.

## Read-only live acceptance

Live acceptance is deliberately opt-in. Without the opt-in flag, the harness exits successfully without reading credentials or contacting GitHub.

Build first:

```powershell
npm run build
```

Default safe skip:

```powershell
npm run acceptance:github
```

Run the live read-only acceptance explicitly:

```powershell
$env:AGENT_CORE_GITHUB_LIVE_ACCEPTANCE='1'
npm run acceptance:github
Remove-Item Env:AGENT_CORE_GITHUB_LIVE_ACCEPTANCE -ErrorAction SilentlyContinue
```

Optional target overrides:

```text
AGENT_CORE_GITHUB_ACCEPTANCE_OWNER
AGENT_CORE_GITHUB_ACCEPTANCE_REPO
```

The harness uses the production `GitHubService` and performs only read-only probes:

- authenticated identity (`GET /user`) through the general GitHub credential;
- repository metadata for the target repository;
- authenticated `git ls-remote` for `HEAD` and the default branch;
- a bounded npm-package listing through the separate Packages credential.

Output uses schema `agent-core-github-live-acceptance/1` and is intentionally metadata-only: configuration booleans, HTTP statuses, repository identity, default branch, bounded ref count, a 12-character HEAD SHA, package count, and safe error codes/messages. It does not output credential values, credential paths, request headers, child environments, raw Git output, or temporary auth files.

A package count of zero is valid if the authenticated account currently has no visible npm packages. Authentication/permission failure is not converted into success.

## Troubleshooting

Common safe error codes include:

```text
GITHUB_CREDENTIAL_MISSING
GITHUB_CREDENTIAL_EMPTY
GITHUB_API_AUTH_FAILED
GITHUB_API_FORBIDDEN
GITHUB_API_RATE_LIMITED
GITHUB_GIT_AUTH_FAILED
GITHUB_PACKAGE_AUTH_FAILED
```

For `GITHUB_API_FORBIDDEN`, compare the intended endpoint with GitHub's current fine-grained-token permissions documentation. For `GITHUB_PACKAGE_AUTH_FAILED`, verify that `packages-token.txt` contains an appropriate personal access token (classic) with at least `read:packages` for read-only acceptance. For Git authentication failures, verify repository access on the general GitHub token; do not solve authentication failures by embedding a token into a remote URL.

## Security invariants

Native GitHub Fabric is accepted only while these invariants remain true:

- no token is tracked by Git or included in release/plugin packages;
- no token is stored in Git remote URLs, Git config, or global npm config;
- raw credentials are absent from MCP responses, operational audit, deterministic memory, and error messages;
- temporary askpass/npm-auth material is removed on success and failure;
- GitHub API credentials cannot be redirected to an unapproved origin;
- workspace path policy still constrains clone destinations, npm working directories, and release asset paths;
- destructive operations cannot bypass the confirmation boundary.
