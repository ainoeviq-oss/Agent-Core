# Commander MCP

Commander MCP is a Windows-hosted custom MCP gateway that provides a stable foundation for Desktop-Commander-style capabilities in a different controlled scope.

V2 exposes a guarded operational toolset for filesystem, search, PowerShell execution, and Commander-managed process sessions while retaining the custom API-key + OAuth bridge and Secure MCP Tunnel compatibility.

## Endpoint

- MCP: `http://127.0.0.1:8765/mcp`
- Health: `http://127.0.0.1:8765/health`
- Authentication: `Authorization: Bearer cmdr_live_...`
- Server identity: `desktop-commander`

## Install

```powershell
cd F:\Projects\Commander-MCP
npm install
npm run build
```

Or double-click `Start-Commander-MCP.bat`. The launcher installs dependencies when missing, builds, and starts the server.

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

Core identity: `commander_status`, `commander_capabilities`, `workspace_info`.

Filesystem: `list_directory`, `read_file`, `read_multiple_files`, `write_file`, `edit_file`, `create_directory`, `move_file`, `get_file_info`.

Search: `search_files` supports filename and text-content modes.

Process/terminal: `execute_command`, `start_process`, `read_process_output`, `stop_process`, `list_processes`.

All paths and process working directories are constrained by `COMMANDER_ALLOWED_ROOTS`. High-risk system/storage/privilege commands are blocked before PowerShell execution. Git semantic tools and GUI/system administration remain deferred.

## HTTP Example

```http
POST /mcp
Authorization: Bearer cmdr_live_xxxxxxxxx
Content-Type: application/json
Accept: application/json, text/event-stream
```

The MCP protocol version used by the installed SDK is `2025-11-25`.


## ChatGPT Connection

The local server remains bound to `127.0.0.1`. ChatGPT reaches it through the OpenAI Secure MCP Tunnel configured for this installation. OAuth discovery, Dynamic Client Registration, PKCE authorization-code exchange, and refresh tokens are implemented by Commander; the authorization page maps the resulting OAuth identity back to a `cmdr_live_...` Commander key.

The tunnel daemon must stay running for discovery and tool calls. The Commander runtime data directory should also remain stable across upgrades so OAuth clients/tokens and key metadata survive branch or binary changes.

## Development Verification

```powershell
npm test
npm run build
```

The production launcher defaults runtime state to `runtime\data` and `runtime\logs`; both are ignored by Git. Override `COMMANDER_DATA_DIR`, `COMMANDER_LOG_DIR`, or semicolon-separated `COMMANDER_ALLOWED_ROOTS` when a different deployment scope is required.

## Hybrid Capability Registry

Commander indexes the local `awesome-korean-agent-skills` catalog into a deferred registry under `F:\Projects\Commander-MCP\capabilities`.

Current registry primitives: `capability_recommend`, `capability_search`, `capability_get`, `skill_load`, `capability_dependencies`, and `capability_coverage`.

Catalog entries stay metadata-only until selected. `skill_load` rejects anything that is not an audited `native_ready` skill. External sources must pass source resolution, license verification, function analysis, and safety review before normalization.

Build the local Commander plugin source package with:

```powershell
npm run build:plugin
```

The package contains the native Commander Capability Router plus audited native-ready skills and references the already-connected Desktop Commander MCP app. Generated package output is ignored by Git; credentials, runtime OAuth state, external caches, and quarantine material are never packaged.
