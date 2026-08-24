# Agent Core Tray Manager - Live Acceptance Checkpoint

Date: 2026-08-25 (Asia/Jakarta)
Feature branch: `feature/agent-core-tray-manager`
Target branch: `main`

## Completed

- Windows tray manager with strict process identity checks, controlled takeover, bounded watchdog recovery, manual restart, autostart toggle, and cooperative exit.
- `Reset OAuth / Re-auth` tray action backs up OAuth state, preserves registered Agent Core API keys, imports legacy ChatGPT OAuth client registration when needed, clears old grants/tokens, and restarts Agent Core.
- OAuth accepts Agent Core custom API keys registered in the local key store; no OpenAI API key is required.
- Windows persistence fallback handles `EPERM`, `EACCES`, and `EBUSY` when atomic rename is blocked by file-sharing semantics, while unrelated rename failures still surface.
- The persistence fallback is shared by `keys.json` and `oauth.json` writes.
- Tunnel executable is derived from the Agent Core root drive rather than a stale fixed drive.
- Agent Core identity accepts canonical absolute or repo-relative `dist/index.js` signatures while still requiring matching listener PID and Node executable.

## Automated verification

- `npm run build`: passed.
- Full suite: 28 test files / 116 tests passed.
- OAuth/key persistence regression tests cover Windows rename-block fallback.
- Tray OAuth tests cover reset, client import, grant clearing, custom-key preservation, and Agent Core restart.

## Live OAuth acceptance

Observed on the canonical local service after reset and runtime deployment:

- `GET /oauth/authorize` -> 200
- `POST /oauth/authorize` -> 302
- `POST /oauth/token` -> 200
- authenticated `POST /mcp` -> 200
- MCP reported `authentication: OAuth2` with the registered Agent Core key identity.

The OAuth reset left three registered clients in the canonical store and zero stale authorization codes, access tokens, or refresh tokens before re-authentication. Backup copies of the pre-reset OAuth store were created.

## Safety

- No raw API key or client secret is committed or logged by these changes.
- `runtime/`, `secrets/`, `tunnel-client/`, and capability cache remain ignored by Git.
- OAuth reset does not delete or rotate Agent Core API keys.
- Service stop paths remain downstream of strict identity validation.