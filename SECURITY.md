# Security

Agent Core is designed as a local control plane, not a public remote shell. Its security model depends on authenticated identity, bounded workspace roots, guarded command execution, local persistence, and strict package exclusions.

## Network boundary

- The MCP/health listener is loopback-bound by default.
- Remote ChatGPT access should use the configured Secure MCP Tunnel.
- Do not expose the local Agent Core port directly to an untrusted network.

## Authentication

- Agent Core supports its own custom API keys and OAuth 2.0 bridge.
- Persisted API-key records store salted hashes and metadata rather than raw key material.
- Raw keys are shown only when created or rotated.
- OAuth client/token state belongs in runtime data and must never be committed.

## Workspace and process boundary

Filesystem and process operations are constrained to configured allowed roots. Agent Core rejects escape paths and blocks high-risk system/storage/privilege command forms before PowerShell execution.

Route-bound mutations additionally require a current authenticated principal/project route context.

## Memory and evidence

Agent Core deliberately separates semantic memory from raw operational evidence:

- raw stdout/stderr remains under the local execution evidence root;
- structured/redacted evidence may be promoted into DMF;
- semantic task completion requires explicit checkpoint finalization;
- missing process/PID state is never interpreted as success.

Raw execution logs may contain sensitive content if a command prints it. Treat the execution evidence directory as operator-sensitive data.

## Capability registry

Third-party capability entries are deferred metadata by default. Full skill instructions may be loaded only after the capability reaches the audited `native_ready` state required by the runtime gate. Quarantined, unresolved, unknown-license and reference-only entries remain non-executable.

## Release/package exclusions

Stable packaging uses an explicit allowlist. The following must never be included in release assets or GitHub Packages:

```text
secrets/
runtime/
data/
logs/
capabilities/
node_modules/
.env
local tunnel credentials
raw execution evidence
OAuth/key databases
quarantine/source caches
```

Release artifacts include SHA-256 checksums.

## Private security reports

This repository is private. Record security-sensitive findings privately in the repository or local Agent Core project context; do not paste raw credentials, OAuth tokens, secret-file contents, or unredacted sensitive execution logs into issues, commits, release notes, or chat responses.
