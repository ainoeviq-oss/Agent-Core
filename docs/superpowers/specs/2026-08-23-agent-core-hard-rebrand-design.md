# Agent Core Hard Rebrand Design

## Goal
Hard-rename the owned custom local-agent system from all prior Commander/Desktop Commander naming to **Agent Core** across source code, protocol identity, tools, credentials, OAuth artifacts, plugin packaging, documentation, local paths, tunnel-facing metadata, and the private GitHub repository.

This is a true identity migration, not a display-name alias. After cutover, Agent Core is the only supported owned identity. The original third-party Desktop Commander remains a separate product/tool and must never be conflated with Agent Core.

## Canonical Naming
- Human/display name: `Agent Core`
- Machine slug: `agent-core`
- TypeScript symbol prefix: `AgentCore`
- MCP server name: `agent-core`
- Service identity: `agent-core`
- npm package name: `agent-core`
- CLI binary/usage name: `agent-core`
- Environment prefix: `AGENT_CORE_`
- MCP identity tools: `agent_core_status`, `agent_core_capabilities`
- Router skill: `agent-core-capability-router`
- Local project root after cutover: `F:\Projects\Agent-Core`
- Plugin source root: `plugin\agent-core`
- Private GitHub repository target: `rendevouz999/Agent-Core`

## Credential and OAuth Identity
Owned credential prefixes also change so no active credential carries the old identity:
- API key: `agent_core_live_...`
- OAuth client ID: `agent_core_client_...`
- OAuth client secret: `agent_core_secret_...`
- Authorization code: `agent_core_code_...`
- OAuth access token: `agent_core_oauth_...`
- OAuth refresh token: `agent_core_refresh_...`

This is intentionally incompatible with existing `cmdr_*` credentials. Existing ChatGPT OAuth sessions must reconnect once after cutover. We will not keep legacy-prefix acceptance code because the approved direction is a hard rename rather than a compatibility layer.

The current runtime credential files are backed up locally before migration. A new Agent Core API key is generated locally and written directly to the new secret file without printing it to logs/chat. Old raw-key files are removed only after the new runtime passes direct acceptance tests.

OAuth clients/access tokens/refresh tokens created under the old identity are archived in the rollback backup and removed from active runtime state. A fresh DCR + PKCE authorization flow is expected for ChatGPT after cutover.

Opaque immutable external IDs such as the OpenAI tunnel resource ID, UUID key IDs, Git commit SHAs, and timestamps are not renamed. They are identifiers, not owned product names.

## Source-Code Rename Scope
All owned source identifiers that encode the old product name are renamed, including but not limited to:
- `CommanderService` -> `AgentCoreService`
- `startCommanderService` -> `startAgentCoreService`
- `createCommanderMcpServer` -> `createAgentCoreMcpServer`
- `BuildCommanderPluginOptions` -> `BuildAgentCorePluginOptions`
- `CommanderPluginBuildResult` -> `AgentCorePluginBuildResult`
- `buildCommanderPluginPackage` -> `buildAgentCorePluginPackage`
- user-visible errors, descriptions, titles, audit text, CLI usage text, and OAuth HTML

Generic capability tools such as `read_file`, `write_file`, `execute_command`, `capability_recommend`, and `skill_load` keep their names because they do not encode the old brand.

The two brand-specific MCP tools are hard-renamed:
- `commander_status` -> `agent_core_status`
- `commander_capabilities` -> `agent_core_capabilities`

No server-side alias for the old tool names remains after cutover.

## Environment Configuration
All owned environment variables move from `COMMANDER_*` to `AGENT_CORE_*`, including host, port, data directory, log directory, capability directory, allowed roots, smoke-test configuration, and plugin-build configuration.

The launcher and examples use only the new variables. Runtime deployment must not depend on old environment-variable aliases.

## File and Directory Rename Scope
Owned tracked paths containing the old brand are renamed. Key examples:
- `Start-Commander-MCP.bat` -> `Start-Agent-Core.bat`
- `plugin/commander/` -> `plugin/agent-core/`
- `plugin/agent-core/skills/commander-capability-router/` -> `plugin/agent-core/skills/agent-core-capability-router/`
- generated `commander-package.json` -> `agent-core-package.json`
- historical design/plan filenames containing `commander-*` -> equivalent `agent-core-*` filenames

The final project checkout is moved from `F:\Projects\Commander-MCP` to `F:\Projects\Agent-Core` only after the feature branch is merged and its worktree removed, so Git worktree metadata never points at a renamed parent unexpectedly.

Local owned runtime paths are migrated with the project root:
- `runtime/`
- `secrets/`
- `capabilities/`
- `tunnel-client/`

The external catalog clone under `capabilities/sources/awesome-korean-agent-skills` remains untouched internally. We do not rewrite third-party/upstream content merely because it may contain unrelated mentions of Commander/Desktop Commander.

## Documentation and Text Sweep
All tracked owned documentation, examples, tests, source comments, package metadata, file names, and generated package metadata are swept for these legacy owned strings:
`Commander`, `COMMANDER_`, `Commander-MCP`, `commander-mcp`, `Desktop Commander`, `desktop-commander`, `commander_*`, `commander-*`, and `cmdr_*`.

A final scanner must report zero legacy owned-name occurrences in tracked project files, except an explicit migration note if needed to explain the one-time rename. Git commit history is not rewritten; preserving historical commits is required for auditability.

## Plugin and MCP Identity
The plugin source package becomes `Agent Core` and contains:
- native `Agent Core Capability Router` skill;
- audited native-ready skills;
- metadata referencing the Agent Core MCP app/runtime;
- no secrets, OAuth state, runtime caches, quarantine content, or raw external-repo caches.

MCP initialization returns server name `agent-core` and title `Agent Core`. Health/status service output uses `agent-core`. OAuth authorization UI says `Agent Core`, not Desktop Commander.

The capability router description and workflow explicitly instruct ChatGPT to use Agent Core discovery/execution tools. This makes phrases such as “pakai Agent Core” unambiguous relative to the third-party Desktop Commander integration.

Because ChatGPT may cache a custom app tool snapshot, the final cutover requires Refresh/Scan Tools or reconnect after the server starts under the new identity. The old custom connection may cease working when old OAuth prefixes are invalidated; that is expected by this hard-rename design.

## Tunnel Migration
The existing OpenAI Secure MCP Tunnel resource ID may remain because it is an opaque external identifier and its route still targets `http://127.0.0.1:8765/mcp`.

Owned tunnel-facing names are changed where supported:
- local profile file -> `tunnel-client/agent-core.yaml`;
- local comments/log labels -> Agent Core;
- OpenAI tunnel display name -> `Agent Core` when the control plane exposes a safe rename operation.

If the control plane does not support renaming the existing tunnel display name, do not invent an API. Keep the immutable working tunnel resource and recreate/reconnect the ChatGPT custom app under `Agent Core`; record the external display-name limitation explicitly.

## Private GitHub Repository Migration
The current private repository `rendevouz999/Desktop-Commander` is renamed to `rendevouz999/Agent-Core` while remaining private and keeping `main` as the default branch.

The rename must preserve repository history rather than creating an unrelated replacement repository. The local `origin` remote is updated to the canonical new URL and verified by comparing local `main` HEAD with `origin/main` after push/fetch.

If the installed Git tooling cannot rename the repository directly, use an authenticated GitHub repository-update path without exposing credentials. Do not print credential-manager output or GitHub tokens.

## Runtime Cutover Sequence
1. Keep current Agent Core predecessor runtime live while feature work occurs in the isolated rebrand worktree.
2. Complete code/docs/file renames with TDD and zero-legacy-name scan.
3. Run the full test/build/package suite in the worktree.
4. Create a local rollback backup of runtime, secrets, capabilities metadata, tunnel profile, and current repository/commit references; never commit the backup.
5. Merge the verified feature branch into `main`.
6. Stop the old runtime process cleanly; keep tunnel resource available unless profile migration requires a brief restart.
7. Remove the feature worktree and rename the project directory to `F:\Projects\Agent-Core`.
8. Rename/update GitHub repository and local `origin`.
9. Migrate runtime/secrets to new filenames and generate a fresh `agent_core_live_...` production key without displaying it.
10. Reset active OAuth client/token state so new connections issue only `agent_core_*` credentials.
11. Rename tunnel profile and supported tunnel display metadata.
12. Start Agent Core production from the new root and run direct authenticated acceptance.
13. Reconnect/refresh the ChatGPT custom app once and verify the new 23-tool surface.

## Rollback Strategy
Before any destructive cutover step, create an untracked timestamped migration backup outside Git containing:
- `runtime/data` and runtime key/OAuth stores;
- owned secret files;
- tunnel profile;
- capability registry/provenance/normalized native-ready material;
- current local root path, Git remote URL, `main` SHA, tunnel ID, and active process information without raw secret values.

Rollback means: stop Agent Core runtime, restore the old project directory/name and backed-up runtime/profile state, point `origin`/tunnel configuration back if necessary, and restart the previously verified `cc2f973` baseline. Repository rename rollback is attempted only if cutover cannot be made healthy.

The migration does not rewrite Git history and does not delete rollback data until the user has successfully tested Agent Core through ChatGPT.

## Security Constraints
- Never print raw API keys, OAuth client secrets, access tokens, refresh tokens, tunnel API keys, or credential-manager passwords.
- Never commit `runtime/`, `secrets/`, `capabilities/` generated/cache data, tunnel credentials, migration backups, or plugin generated output.
- Hard rename must not weaken filesystem workspace boundaries or process command guardrails.
- Credential migration is local and atomic where practical: create/test new identity before deleting old raw-key files.
- Third-party sources are not modified.
- The private GitHub repository must remain private throughout the rename.

## Test Strategy
TDD covers the new identity contract before production code is renamed:
- config reads only `AGENT_CORE_*` variables;
- new credentials use only `agent_core_*` prefixes and old prefixes fail verification;
- OAuth DCR/code/access/refresh flows issue only Agent Core prefixes;
- MCP initialization returns `agent-core` / `Agent Core`;
- tool discovery includes `agent_core_status` and `agent_core_capabilities` and excludes the old brand-specific tool names;
- package builder emits `Agent Core`, `agent-core-capability-router`, and `agent-core-package.json`;
- launcher/docs/package metadata contain no old owned brand strings;
- existing 15 operational tools and 6 capability tools retain behavior;
- 415 capability registry coverage and native-ready gating remain unchanged.

After merge and directory/repository migration, run fresh acceptance from `F:\Projects\Agent-Core`:
- full test suite;
- TypeScript build;
- plugin package build;
- direct MCP health;
- `tools/list` count and exact brand-specific names;
- `agent_core_status` identity/version;
- `capability_coverage` totals;
- `capability_recommend` + one native-ready `skill_load`;
- tunnel readiness HTTP 200;
- Git local `main` equals private `origin/main`;
- zero tracked secret/cache/runtime artifacts.

## Acceptance Criteria
1. Owned active project files contain no legacy Commander/Desktop Commander brand strings after the migration scan, except the explicitly documented migration history note if retained.
2. Project root is `F:\Projects\Agent-Core` and old `F:\Projects\Commander-MCP` is no longer the active checkout.
3. Private GitHub repository is `rendevouz999/Agent-Core`, remains private, and `main` matches local `main`.
4. MCP identifies as `agent-core` / `Agent Core` and exposes `agent_core_status` + `agent_core_capabilities`.
5. All new API/OAuth credentials use `agent_core_*` prefixes; active runtime no longer accepts old `cmdr_*` prefixes.
6. Current ChatGPT OAuth identity is intentionally replaced by one fresh Agent Core authorization; no hidden legacy-prefix compatibility is enabled.
7. Agent Core plugin source contains `agent-core-capability-router` plus only audited native-ready skills, with required license/provenance material.
8. All existing machine-control behavior remains: filesystem, search, bounded PowerShell execution, process sessions, workspace guardrails, OAuth/API-key auth, and deferred capability discovery.
9. Capability registry remains fully accounted: 415 catalog entries at current source revision unless upstream catalog legitimately changes during an explicit sync.
10. Full tests, build, plugin build, direct live acceptance, and tunnel readiness all pass after cutover.
11. Migration backup exists locally and remains uncommitted until the user completes live ChatGPT testing.
12. Git history is preserved; no force rewrite is used merely to erase historical names from past commit messages.

## Explicit Non-Goals
- Renaming or modifying the third-party Desktop Commander product/plugin.
- Rewriting third-party catalog/source content.
- Rewriting Git history or commit messages.
- Changing the MCP port merely for branding; keep port `8765` unless a technical conflict appears.
- Changing the OpenAI tunnel resource ID solely because it was created before the rename.
- Keeping compatibility aliases for old tool names, environment variables, API-key prefixes, or OAuth token prefixes.
- Expanding permissions, GUI automation, Git semantic tools, or broad system-administration capabilities as part of this rebrand.

## User-Facing Meaning After Cutover
`Agent Core` always means the custom private system built in this project: ChatGPT -> Agent Core plugin/skill layer -> Agent Core MCP runtime -> controlled local machine capabilities.

`Desktop Commander` always means the separate third-party/original integration. After the migration, owned Agent Core files and runtime UI must not use “Desktop Commander” as their own name.
