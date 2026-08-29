#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$ROOT/../.." && pwd)"
BIN="$ROOT/runtime/bin/tunnel-client"
PROFILE_NAME="codespace"
PROFILE_DIR="$ROOT/runtime/profiles"
PROFILE_FILE="$PROFILE_DIR/$PROFILE_NAME.yaml"
STATE_DIR="$ROOT/runtime/state"
ALIAS="codespace"

PHASE=""
FORCE_RECONNECT=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --phase)
      [[ $# -ge 2 ]] || {
        printf '%s\n' "Usage: $0 --phase create|start|attach|manual [--force-reconnect]" >&2
        exit 2
      }
      PHASE="$2"
      shift 2
      ;;
    --force-reconnect)
      FORCE_RECONNECT=true
      shift
      ;;
    *)
      printf '%s\n' "Usage: $0 --phase create|start|attach|manual [--force-reconnect]" >&2
      exit 2
      ;;
  esac
done

case "$PHASE" in
  create|start|attach|manual) ;;
  *)
    printf '%s\n' "Usage: $0 --phase create|start|attach|manual [--force-reconnect]" >&2
    exit 2
    ;;
esac

# postStart and postAttach can run close together. Serialize lifecycle recovery so
# one invocation cannot stop a runtime another invocation has just registered.
LOCK_FILE="${TMPDIR:-/tmp}/codespace-ensure-running.lock"
exec 9>"$LOCK_FILE"
if ! flock -w 120 9; then
  printf '%s\n' "[codespace] ERROR: timed out waiting for lifecycle recovery lock." >&2
  exit 1
fi

RUNTIME_API_KEY_FILE="$REPO_ROOT/secrets/github/CONTROL_PLANE_API_KEY"

# Codespaces lifecycle secrets may be available during create/start but absent
# from later tool children. Persist an injected credential only into ignored
# workspace state with owner-only permissions, then always reference it by file.
# The value is never printed and is removed from the remaining startup env.
if [[ -n "${CONTROL_PLANE_API_KEY:-}" ]]; then
  mkdir -p "$(dirname "$RUNTIME_API_KEY_FILE")"
  umask 077
  runtime_api_key_tmp="$RUNTIME_API_KEY_FILE.tmp.$$"
  printf '%s\n' "$CONTROL_PLANE_API_KEY" > "$runtime_api_key_tmp"
  chmod 600 "$runtime_api_key_tmp"
  mv -f "$runtime_api_key_tmp" "$RUNTIME_API_KEY_FILE"
fi

if [[ -s "$RUNTIME_API_KEY_FILE" ]]; then
  chmod 600 "$RUNTIME_API_KEY_FILE"
  RUNTIME_API_KEY_REF="file:$RUNTIME_API_KEY_FILE"
else
  printf '%s\n' "[codespace] ERROR: runtime credential is unavailable." >&2
  exit 1
fi
unset CONTROL_PLANE_API_KEY

CANONICAL_TUNNEL_ID=""
if [[ -f "$ROOT/runtime/tunnel.json" ]]; then
  CANONICAL_TUNNEL_ID="$(node -e '
const fs = require("node:fs");
const file = process.argv[1];
try {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (typeof value.tunnelId === "string") process.stdout.write(value.tunnelId);
} catch {}
' "$ROOT/runtime/tunnel.json")"
fi

TRACKED_TUNNEL_ID="$(node -e '
const fs = require("node:fs");
const file = process.argv[1];
try {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (typeof value.tunnelId === "string") process.stdout.write(value.tunnelId);
} catch {}
' "$ROOT/config/tunnel.defaults.json")"

# The codespace bridge owns a fixed, tracked non-secret tunnel identity. An
# explicit codespace override wins, then the tracked default rebuilds runtime
# state from scratch. Existing runtime state and the legacy Agent Core variable
# remain migration fallbacks only.
TUNNEL_SOURCE=""
TUNNEL_ID="${CODESPACE_TUNNEL_ID:-}"
if [[ -n "$TUNNEL_ID" ]]; then
  TUNNEL_SOURCE="env:CODESPACE_TUNNEL_ID"
elif [[ -n "$TRACKED_TUNNEL_ID" ]]; then
  TUNNEL_ID="$TRACKED_TUNNEL_ID"
  TUNNEL_SOURCE="config/tunnel.defaults.json"
elif [[ -n "$CANONICAL_TUNNEL_ID" ]]; then
  TUNNEL_ID="$CANONICAL_TUNNEL_ID"
  TUNNEL_SOURCE="runtime/tunnel.json (migration fallback)"
elif [[ -n "${CONTROL_PLANE_TUNNEL_ID:-}" ]]; then
  TUNNEL_ID="$CONTROL_PLANE_TUNNEL_ID"
  TUNNEL_SOURCE="env:CONTROL_PLANE_TUNNEL_ID (legacy fallback)"
fi

if [[ -z "$TUNNEL_ID" ]]; then
  printf '%s\n' "Run plugin/codespace/scripts/configure-tunnel.sh with the tunnel ID shown in OpenAI Platform Tunnels." >&2
  exit 1
fi

if [[ ! "$TUNNEL_ID" =~ ^tunnel_[A-Za-z0-9_-]+$ ]]; then
  printf '%s\n' "[codespace] ERROR: invalid tunnel ID format." >&2
  exit 1
fi

if [[ "$CANONICAL_TUNNEL_ID" != "$TUNNEL_ID" ]]; then
  bash "$ROOT/scripts/configure-tunnel.sh" "$TUNNEL_ID"
  CANONICAL_TUNNEL_ID="$TUNNEL_ID"
fi

printf '%s\n' "[codespace] tunnel source=$TUNNEL_SOURCE tunnel_id=$TUNNEL_ID"

bash "$ROOT/scripts/install-tunnel-client.sh"

mkdir -p "$PROFILE_DIR" "$STATE_DIR"
export TUNNEL_CLIENT_STATE_DIR="$STATE_DIR"

command -v node >/dev/null 2>&1 || {
  printf '%s\n' "[codespace] ERROR: node is unavailable." >&2
  exit 1
}
command -v npm >/dev/null 2>&1 || {
  printf '%s\n' "[codespace] ERROR: npm is unavailable." >&2
  exit 1
}

needs_dependencies=false
if [[ ! -x "$ROOT/node_modules/.bin/tsc" || ! -x "$ROOT/node_modules/.bin/vitest" ]]; then
  needs_dependencies=true
elif [[ ! -f "$ROOT/node_modules/@modelcontextprotocol/sdk/package.json" || ! -f "$ROOT/node_modules/zod/package.json" ]]; then
  needs_dependencies=true
elif ! (cd "$ROOT" && npm ls --depth=0 >/dev/null 2>&1); then
  needs_dependencies=true
fi

if [[ "$needs_dependencies" == true ]]; then
  printf '%s\n' "[codespace] restoring standalone plugin dependencies."
  (
    cd "$ROOT"
    npm ci --ignore-scripts
  )
fi

needs_build=false
if [[ ! -f "$ROOT/dist/server.js" || ! -f "$ROOT/dist/http-server.js" || ! -f "$ROOT/dist/http-probe.js" || ! -f "$ROOT/dist/watchdog.js" ]]; then
  needs_build=true
elif find "$ROOT/src" -type f -name '*.ts' -newer "$ROOT/dist/server.js" -print -quit | grep -q .; then
  needs_build=true
elif [[ "$ROOT/package.json" -nt "$ROOT/dist/server.js" || "$ROOT/package-lock.json" -nt "$ROOT/dist/server.js" ]]; then
  needs_build=true
fi

if [[ "$needs_build" == true ]]; then
  (
    cd "$ROOT"
    "$ROOT/node_modules/.bin/tsc" -p tsconfig.json
  )
fi

(
  cd "$REPO_ROOT"
  NODE_ENV=test "$ROOT/node_modules/.bin/vitest" run \
    plugin/codespace/tests/mcp.integration.test.ts \
    plugin/codespace/tests/http-mcp.integration.test.ts
)

(
  exec 9>&-
  bash "$ROOT/scripts/ensure-http-mcp.sh"
)
MCP_SERVER_URL_FILE="$ROOT/runtime/state/http-mcp.url"
MCP_SERVER_URL="$(tr -d '\r\n' < "$MCP_SERVER_URL_FILE")"
if [[ ! "$MCP_SERVER_URL" =~ ^http://127\.0\.0\.1:[0-9]+/mcp$ ]]; then
  printf '%s\n' "[codespace] ERROR: invalid loopback MCP URL produced by supervisor." >&2
  exit 1
fi
timeout 15 node "$ROOT/dist/http-probe.js" "$MCP_SERVER_URL" >/dev/null

# Keep the currently registered route alive until the replacement MCP target has
# passed a real protocol exchange. This minimizes connector downtime during a
# restart, rebuild, or watchdog repair.
if [[ "$FORCE_RECONNECT" == true ]]; then
  "$BIN" runtimes stop "$ALIAS" >/dev/null 2>&1 || true
else
  case "$PHASE" in
    start|attach)
      "$BIN" runtimes stop "$ALIAS" >/dev/null 2>&1 || true
      ;;
  esac
fi

connect_rc=0
(
  # Keep the lifecycle lock in the parent shell, but never leak its descriptor
  # into tunnel-client's long-lived managed runtime or MCP descendants.
  exec 9>&-

  # tunnel-client v0.0.13 prefers tmux when it is installed. The Codespaces
  # universal image currently ships tmux 3.0a, whose `source-file -` behavior
  # is incompatible with that managed launch path. Make tmux unavailable only
  # to this connect subprocess so tunnel-client uses its own managed process
  # fallback. The loopback MCP server is supervised independently.
  source "$ROOT/scripts/runtime-environment.sh"
  codespace_prepare_process_runtime "$ROOT"

  "$BIN" runtimes connect \
    --alias "$ALIAS" \
    --tunnel-id "$TUNNEL_ID" \
    --profile "$PROFILE_NAME" \
    --profile-dir "$PROFILE_DIR" \
    --runtime-api-key "$RUNTIME_API_KEY_REF" \
    --mcp-server-url "$MCP_SERVER_URL"
) >/dev/null || connect_rc=$?

if [[ "$connect_rc" -ne 0 && "$connect_rc" -ne 2 ]]; then
  printf '%s\n' "[codespace] ERROR: managed runtime connect failed." >&2
  exit "$connect_rc"
fi

status_json=""
status_gate_passed=false
for _ in $(seq 1 10); do
  status_json="$($BIN runtimes status "$ALIAS" --json 2>/dev/null || true)"
  if EXPECTED_TUNNEL_ID="$TUNNEL_ID" EXPECTED_MCP_SERVER_URL="$MCP_SERVER_URL" STATUS_JSON="$status_json" node <<'NODE'
try {
  const payload = JSON.parse(process.env.STATUS_JSON || '{}');
  const expectedTunnelId = process.env.EXPECTED_TUNNEL_ID;
  const expectedMcpServerUrl = process.env.EXPECTED_MCP_SERVER_URL;
  const localReady =
    payload.process_running === true &&
    payload.healthy === true &&
    payload.ready === true &&
    payload.runtime_state === 'ready' &&
    payload.stale === false &&
    payload.tunnel_id === expectedTunnelId;
  const remoteReady =
    payload.remote_lookup_attempted === true &&
    payload.remote_error === '' &&
    payload.remote?.id === expectedTunnelId &&
    typeof payload.remote_lookup_auth_ref === 'string' &&
    payload.remote_lookup_auth_ref.startsWith('file:');
  const targetReady =
    payload.process?.target_kind === 'server_url' &&
    payload.process?.target_value === expectedMcpServerUrl;
  process.exit(localReady && remoteReady && targetReady ? 0 : 1);
} catch {
  process.exit(1);
}
NODE
  then
    status_gate_passed=true
    break
  fi
  sleep 1
done

if [[ "$status_gate_passed" != true ]]; then
  EXPECTED_TUNNEL_ID="$TUNNEL_ID" EXPECTED_MCP_SERVER_URL="$MCP_SERVER_URL" STATUS_JSON="$status_json" node <<'NODE'
let payload = {};
try { payload = JSON.parse(process.env.STATUS_JSON || '{}'); } catch {}
const expectedTunnelId = process.env.EXPECTED_TUNNEL_ID;
const expectedMcpServerUrl = process.env.EXPECTED_MCP_SERVER_URL;
console.error(
  `[codespace] ERROR: managed runtime/platform gate failed (` +
  `tunnel_id=${payload.tunnel_id ?? '<missing>'} expected_tunnel_id=${expectedTunnelId ?? '<missing>'} ` +
  `process_running=${payload.process_running === true} healthy=${payload.healthy === true} ` +
  `ready=${payload.ready === true} runtime_state=${payload.runtime_state ?? '<missing>'} ` +
  `stale=${payload.stale ?? '<missing>'} remote_lookup_attempted=${payload.remote_lookup_attempted === true} ` +
  `remote_error=${payload.remote_error || '<none>'} remote_id=${payload.remote?.id ?? '<missing>'} ` +
  `target_kind=${payload.process?.target_kind ?? '<missing>'} target_value=${payload.process?.target_value ?? '<missing>'} ` +
  `expected_target=${expectedMcpServerUrl ?? '<missing>'}).`,
);
NODE
  exit 1
fi

# Re-run a real MCP initialize/list-tools exchange after tunnel registration.
# Local TCP health alone is never accepted as bridge readiness.
timeout 15 node "$ROOT/dist/http-probe.js" "$MCP_SERVER_URL" >/dev/null

# Run diagnostics only after connect + status + MCP protocol reconciliation.
"$BIN" doctor \
  --profile "$PROFILE_NAME" \
  --profile-dir "$PROFILE_DIR" \
  --explain

if [[ "${CODESPACE_WATCHDOG_ACTIVE:-0}" != "1" ]]; then
  command -v tmux >/dev/null 2>&1 || {
    printf '%s\n' "[codespace] ERROR: tmux is required to supervise bridge recovery." >&2
    exit 1
  }
  WATCHDOG_SESSION="${CODESPACE_WATCHDOG_SESSION:-codespace-bridge-watchdog}"
  WATCHDOG_LOG="$STATE_DIR/logs/watchdog.log"
  mkdir -p "$(dirname "$WATCHDOG_LOG")"
  (
    exec 9>&-
    CODESPACE_EXPECTED_TUNNEL_ID="$TUNNEL_ID" \
    CODESPACE_MCP_SERVER_URL="$MCP_SERVER_URL" \
    TUNNEL_CLIENT_STATE_DIR="$STATE_DIR" \
    bash "$ROOT/scripts/start-watchdog.sh" --once
  )
  tmux kill-session -t "$WATCHDOG_SESSION" >/dev/null 2>&1 || true
  printf -v watchdog_command \
    'exec env CODESPACE_EXPECTED_TUNNEL_ID=%q CODESPACE_MCP_SERVER_URL=%q TUNNEL_CLIENT_STATE_DIR=%q bash %q >>%q 2>&1' \
    "$TUNNEL_ID" "$MCP_SERVER_URL" "$STATE_DIR" "$ROOT/scripts/start-watchdog.sh" "$WATCHDOG_LOG"
  (
    exec 9>&-
    tmux new-session -d -s "$WATCHDOG_SESSION" -c "$ROOT" "$watchdog_command"
  )
  watchdog_ready=false
  for _ in $(seq 1 10); do
    if tmux has-session -t "$WATCHDOG_SESSION" >/dev/null 2>&1; then
      watchdog_ready=true
      sleep 0.2
      if tmux has-session -t "$WATCHDOG_SESSION" >/dev/null 2>&1; then
        break
      fi
      watchdog_ready=false
    fi
    sleep 0.2
  done
  if [[ "$watchdog_ready" != true ]]; then
    printf '%s\n' "[codespace] ERROR: bridge watchdog failed to remain active." >&2
    if [[ -f "$WATCHDOG_LOG" ]]; then tail -40 "$WATCHDOG_LOG" >&2 || true; fi
    exit 1
  fi
fi

printf '%s\n' "[codespace] READY: phase=$PHASE tunnel_id=$TUNNEL_ID loopback MCP protocol, managed tunnel process, remote registration, watchdog, and readiness gates passed."
