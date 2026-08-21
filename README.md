# Commander MCP

Commander MCP is a Windows-hosted custom MCP gateway that provides a stable foundation for Desktop-Commander-style capabilities in a different controlled scope.

V1 focuses on transport and identity rather than computer mutation. It exposes a local Streamable HTTP MCP endpoint protected by custom bearer API keys.

## V1 Endpoint

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

- `commander_status` — reports server/runtime/auth identity and the authenticated key identity.
- `commander_capabilities` — reports enabled V1 features and the capability families deferred to later stages.

Filesystem, terminal, process, search, Git, workspace isolation, OAuth, and tunnel exposure are deliberately not enabled in V1.

## HTTP Example

```http
POST /mcp
Authorization: Bearer cmdr_live_xxxxxxxxx
Content-Type: application/json
Accept: application/json, text/event-stream
```

The MCP protocol version used by the installed SDK is `2025-11-25`.


## ChatGPT Connection Note

This V1 server binds to localhost and uses custom bearer API keys. A cloud ChatGPT custom plugin cannot directly reach `127.0.0.1`, and the current ChatGPT plugin form may require OAuth for authenticated MCP servers.

The next integration stage is therefore intentionally separate:

1. add a secure remote/tunnel transport path;
2. add an OAuth compatibility bridge for ChatGPT while keeping Commander API keys as the internal credential model;
3. then add scoped filesystem/terminal/process capabilities behind per-key authorization policies.

## Development Verification

```powershell
npm test
npm run build
```

Generated key data and audit logs remain under `data\` and `logs\` and are ignored by Git.
