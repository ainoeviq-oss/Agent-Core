# Agent Core MCP

Agent Core MCP is a Windows-hosted custom MCP gateway that provides a stable foundation for Agent-Core-style capabilities in a different controlled scope.

V2 exposes a guarded operational toolset for filesystem, search, PowerShell execution, and Agent Core-managed process sessions while retaining the custom API-key + OAuth bridge and Secure MCP Tunnel compatibility.

## Endpoint

- MCP: `http://127.0.0.1:8765/mcp`
- Health: `http://127.0.0.1:8765/health`
- Authentication: `Authorization: Bearer agent_core_live_...`
- Server identity: `agent-core`

## Install

```powershell
cd F:\Projects\Agent-Core
npm install
npm run build
```

Or double-click `Start-Agent-Core.bat`. The launcher installs dependencies when missing, builds, and starts the server.

## Create an API Key

```powershell
node dist\cli.js create-key chatgpt
```

The returned `key` value is shown once. The persisted `data\keys.json` stores only a salted scrypt hash and metadata.


## Key Administration

```powershell
node dist\cli.js list-keys
node dist\cli.js revoke-key <key-id>
node dist\cli.js rotate-key <key-id>
```

`list-keys` never prints raw API-key material. Rotation revokes the old key and emits a new raw key once.

## MCP Tools

Core identity: `agent_core_status`, `agent_core_capabilities`, `workspace_info`.

Filesystem: `list_directory`, `read_file`, `read_multiple_files`, `write_file`, `edit_file`, `create_directory`, `move_file`, `get_file_info`.

Search: `search_files` supports filename and text-content modes.

Process/terminal: `execute_command`, `start_process`, `read_process_output`, `stop_process`, `list_processes`.

All paths and process working directories are constrained by `AGENT_CORE_ALLOWED_ROOTS`. High-risk system/storage/privilege commands are blocked before PowerShell execution. Git semantic tools and GUI/system administration remain deferred.

## HTTP Example

```http
POST /mcp
Authorization: Bearer agent_core_live_xxxxxxxxx
Content-Type: application/json
Accept: application/json, text/event-stream
```

The MCP protocol version used by the installed SDK is `2025-11-25`.


## ChatGPT Connection

The local server remains bound to `127.0.0.1`. ChatGPT reaches it through the OpenAI Secure MCP Tunnel configured for this installation. OAuth discovery, Dynamic Client Registration, PKCE authorization-code exchange, and refresh tokens are implemented by Agent Core; the authorization page maps the resulting OAuth identity back to a `agent_core_live_...` Agent Core key.

After an Agent Core identity or credential reset, any pre-existing ChatGPT app connection must be reconnected once and its tools scanned/refreshed so the app metadata and tool snapshot use Agent Core. Legacy credential prefixes are not accepted.

The tunnel daemon must stay running for discovery and tool calls. The Agent Core runtime data directory should also remain stable across upgrades so OAuth clients/tokens and key metadata survive branch or binary changes.

## Development Verification

```powershell
npm test
npm run build
```

The production launcher defaults runtime state to `runtime\data` and `runtime\logs`; both are ignored by Git. Override `AGENT_CORE_DATA_DIR`, `AGENT_CORE_LOG_DIR`, or semicolon-separated `AGENT_CORE_ALLOWED_ROOTS` when a different deployment scope is required.

## Hybrid Capability Registry

Agent Core indexes the local `awesome-korean-agent-skills` catalog into a deferred registry under `F:\Projects\Agent-Core\capabilities`.

Current registry primitives: `capability_recommend`, `capability_search`, `capability_get`, `skill_load`, `capability_dependencies`, and `capability_coverage`.

Catalog entries stay metadata-only until selected. `skill_load` rejects anything that is not an audited `native_ready` skill. External sources must pass source resolution, license verification, function analysis, and safety review before normalization.

Build the local Agent Core plugin source package with:

```powershell
npm run build:plugin
```

The package contains the native Agent Core Capability Router plus audited native-ready skills and references the already-connected Agent Core MCP app. Generated package output is ignored by Git; credentials, runtime OAuth state, external caches, and quarantine material are never packaged.

## Agent Core v0.5 Automatic Capability Routing

Agent Core v0.5.0 promotes routing from an optional recommendation step into an internal execution preflight. Normal user briefs are routed with `capability_route`; the returned `routeContextId` is reused across the route-required operations that belong to the same coherent goal.

If the route selects a required audited skill, load it with `skill_load(id, routeContextId)` before route-bound execution. Only `native_ready` skills may be full-instruction-loaded; catalog-only, reference-only, quarantined, unresolved, and unknown-license material remains non-executable guidance or metadata.

Automatic routing is intentionally invisible to the normal prompt surface. Users should not need to mention capability tools, route IDs, or skill-loading primitives. Routing details should surface only when a risk, dependency, required approval, or route failure materially helps the user.

After deploying v0.5.0, refresh the ChatGPT Agent Core app once with **Scan Tools / Refresh Tools** and update the Agent Core Capability Router Skill once. This refresh is required so ChatGPT replaces the cached capability schema with `capability_route` and sees `routeContextId` on route-bound operational tools.
