# Commander MCP V1 Design

## Goal
Build a Windows-hosted MCP gateway at `F:\Projects\Commander-MCP` that exposes a Streamable HTTP MCP endpoint protected by custom bearer API keys.

## Scope
V1 proves transport, authentication, key lifecycle, MCP discovery, tool invocation, health, logging, and one-click startup. It intentionally does not yet expose filesystem, terminal, process, Git, or workspace-control tools.

## Runtime
- Platform: Windows x64.
- Node.js: existing Node 24 runtime.
- Language: TypeScript.
- MCP SDK: `@modelcontextprotocol/sdk` 1.30.0.
- Validation: Zod 4.4.3.
- Tests: Vitest 4.1.11.
- Bind address: `127.0.0.1` by default.
- Default port: `8765`.

## Public HTTP Contract
- `GET /health` returns process health without requiring an API key.
- `POST /mcp` is the MCP Streamable HTTP endpoint.
- `/mcp` requires `Authorization: Bearer <key>`.
- Missing, malformed, unknown, revoked, or expired keys return HTTP 401.
- MCP sessions are transport-managed; authentication is evaluated on every HTTP request.

## API-Key Model
- Generated keys use prefix `cmdr_live_` followed by cryptographically secure random material.
- Raw keys are displayed only when created.
- Persistent storage contains a salted `scrypt` hash, metadata, timestamps, status, and optional expiration; never the raw key.
- Key comparisons use constant-time comparison after deriving the candidate hash.
- CLI operations: `create-key`, `list-keys`, `revoke-key`, and `rotate-key`.
- Default state location is `F:\Projects\Commander-MCP\data` and can be overridden only by explicit environment configuration.

## MCP Identity and Tools
Server name: `desktop-commander`.
Server description: a custom Commander MCP gateway for controlled local capabilities.

V1 tools:
- `commander_status`: returns server identity, version, runtime, authentication mode, and current key identity.
- `commander_capabilities`: returns the V1 capability manifest and explicitly reports that filesystem, terminal, process, Git, and workspace mutation are not enabled yet.

## Logging
- Request audit records contain timestamp, request id, route, authenticated key id/name when available, HTTP status, and duration.
- Raw bearer tokens are never logged.
- Logs are written beneath `F:\Projects\Commander-MCP\logs`.
- Secret material and key database files are ignored by Git.

## Startup and Operations
- `Start-Commander-MCP.bat` starts the compiled server from the project directory.
- `.env.example` documents host, port, data directory, and log directory settings without containing secrets.
- Production startup must fail clearly if required directories cannot be created or if the port is unavailable.
- Graceful shutdown closes active MCP transports and the HTTP listener.

## Acceptance Tests
1. Missing bearer credential on `/mcp` returns 401.
2. Invalid bearer credential returns 401.
3. A valid generated key can perform MCP `initialize`.
4. The authenticated client can call `tools/list` and see both V1 tools.
5. The authenticated client can call both V1 tools and receive deterministic structured results.
6. A revoked key returns 401 on subsequent requests.
7. Rotation revokes the previous key and creates a different valid replacement.
8. `npm test` exits 0.
9. `npm run build` exits 0.
10. A live smoke test against `127.0.0.1:8765` proves health, unauthorized rejection, authenticated initialization, tool listing, and tool invocation.

## Deferred V2
Filesystem, terminal, process, search, Git, workspace jail, approvals, OAuth bridge, and external tunnel exposure are separate follow-on increments after V1 acceptance.