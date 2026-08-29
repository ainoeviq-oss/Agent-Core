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

if [[ $# -ne 2 || "${1:-}" != "--phase" ]]; then
  printf '%s\n' "Usage: $0 --phase create|start|attach|manual" >&2
  exit 2
fi

PHASE="$2"
case "$PHASE" in
  create|start|attach|manual) ;;
  *)
    printf '%s\n' "Usage: $0 --phase create|start|attach|manual" >&2
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
PUBLIC_RUNTIME_KEY_FILE="$ROOT/runtime/public-control-plane-key.txt"
BOOTSTRAP_CONFIG_FILE="$ROOT/config/bootstrap.defaults.json"

BOOTSTRAP_CONTROL_PLANE_BASE_URL="$(node -e '
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (typeof value.controlPlaneBaseUrl === "string") process.stdout.write(value.controlPlaneBaseUrl);
' "$BOOTSTRAP_CONFIG_FILE")"
BOOTSTRAP_PUBLIC_RUNTIME_KEY="$(node -e '
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (typeof value.publicRuntimeKey === "string") process.stdout.write(value.publicRuntimeKey);
' "$BOOTSTRAP_CONFIG_FILE")"
BOOTSTRAP_TUNNEL_ID="$(node -e '
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (typeof value.tunnelId === "string") process.stdout.write(value.tunnelId);
' "$BOOTSTRAP_CONFIG_FILE")"

# Codespaces lifecycle secrets may be available during create/start but absent
# from later tool children. Persist an injected credential only into ignored
# workspace state with owner-only permissions. A truly fresh fork has no local
# secret at all, so it falls back to the tracked public credential for the
# fixed-tunnel control-plane proxy; the real OpenAI runtime key stays server-side.
if [[ -n "${CONTROL_PLANE_API_KEY:-}" ]]; then
  mkdir -p "$(dirname "$RUNTIME_API_KEY_FILE")"
  umask 077
  runtime_api_key_tmp="$RUNTIME_API_KEY_FILE.tmp.$$"
  printf '%s\n' "$CONTROL_PLANE_API_KEY" > "$runtime_api_key_tmp"
  chmod 600 "$runtime_api_key_tmp"
  mv -f "$runtime_api_key_tmp" "$RUNTIME_API_KEY_FILE"
fi
unset CONTROL_PLANE_API_KEY

CONTROL_PLANE_BASE_URL="https://api.openai.com"
if [[ -s "$RUNTIME_API_KEY_FILE" ]]; then
  chmod 600 "$RUNTIME_API_KEY_FILE"
  RUNTIME_API_KEY_REF="file:$RUNTIME_API_KEY_FILE"
  CREDENTIAL_MODE="local-runtime-key"
else
  if [[ ! "$BOOTSTRAP_CONTROL_PLANE_BASE_URL" =~ ^https:// ]] || [[ -z "$BOOTSTRAP_PUBLIC_RUNTIME_KEY" ]]; then
    printf '%s\n' "[codespace] ERROR: tracked fresh-machine bootstrap configuration is invalid." >&2
    exit 1
  fi
  mkdir -p "$(dirname "$PUBLIC_RUNTIME_KEY_FILE")"
  umask 077
  printf '%s\n' "$BOOTSTRAP_PUBLIC_RUNTIME_KEY" > "$PUBLIC_RUNTIME_KEY_FILE"
  chmod 600 "$PUBLIC_RUNTIME_KEY_FILE"
  RUNTIME_API_KEY_REF="file:$PUBLIC_RUNTIME_KEY_FILE"
  CONTROL_PLANE_BASE_URL="$BOOTSTRAP_CONTROL_PLANE_BASE_URL"
  CREDENTIAL_MODE="public-control-plane-proxy"
fi

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

if [[ -n "$BOOTSTRAP_TUNNEL_ID" && "$BOOTSTRAP_TUNNEL_ID" != "$TUNNEL_ID" ]]; then
  printf '%s\n' "[codespace] ERROR: bootstrap tunnel identity does not match the active codespace tunnel." >&2
  exit 1
fi

if [[ "$CANONICAL_TUNNEL_ID" != "$TUNNEL_ID" ]]; then
  bash "$ROOT/scripts/configure-tunnel.sh" "$TUNNEL_ID"
  CANONICAL_TUNNEL_ID="$TUNNEL_ID"
fi

printf '%s\n' "[codespace] tunnel source=$TUNNEL_SOURCE tunnel_id=$TUNNEL_ID credential_mode=$CREDENTIAL_MODE"

bash "$ROOT/scripts/install-tunnel-client.sh"

mkdir -p "$PROFILE_DIR" "$STATE_DIR"
export TUNNEL_CLIENT_STATE_DIR="$STATE_DIR"

# A locally healthy process can still have stale platform registration after a
# Codespace restart. Lifecycle start/attach therefore performs one controlled
# stop before reconnecting the same alias+tunnel. This is intentionally skipped
# for manual invocations so diagnostics do not flap a healthy tunnel.
case "$PHASE" in
  start|attach)
    "$BIN" runtimes stop "$ALIAS" >/dev/null 2>&1 || true
    ;;
esac

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
if [[ ! -f "$ROOT/dist/server.js" ]]; then
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
  NODE_ENV=test "$ROOT/node_modules/.bin/vitest" run plugin/codespace/tests/mcp.integration.test.ts
)

connect_rc=0
(
  # Keep the lifecycle lock in the parent shell, but never leak its descriptor
  # into tunnel-client's long-lived managed runtime or MCP descendants.
  exec 9>&-

  # tunnel-client v0.0.13 prefers tmux when it is installed. The Codespaces
  # universal image currently ships tmux 3.0a, whose `source-file -` behavior
  # is incompatible with that managed launch path. Make tmux unavailable only
  # to this connect subprocess so tunnel-client uses its own managed process
  # fallback. start-mcp.sh restores the original PATH before MCP starts.
  source "$ROOT/scripts/runtime-environment.sh"
  codespace_prepare_process_runtime "$ROOT"

  "$BIN" runtimes connect \
    --alias "$ALIAS" \
    --tunnel-id "$TUNNEL_ID" \
    --profile "$PROFILE_NAME" \
    --profile-dir "$PROFILE_DIR" \
    --control-plane-base-url "$CONTROL_PLANE_BASE_URL" \
    --runtime-api-key "$RUNTIME_API_KEY_REF" \
    --mcp-command "bash $ROOT/scripts/start-mcp.sh"
) >/dev/null || connect_rc=$?

if [[ "$connect_rc" -ne 0 && "$connect_rc" -ne 2 ]]; then
  printf '%s\n' "[codespace] ERROR: managed runtime connect failed." >&2
  exit "$connect_rc"
fi

status_json=""
status_gate_passed=false
for _ in $(seq 1 10); do
  status_json="$($BIN runtimes status "$ALIAS" --json 2>/dev/null || true)"
  if EXPECTED_TUNNEL_ID="$TUNNEL_ID" STATUS_JSON="$status_json" node <<'NODE'
try {
  const payload = JSON.parse(process.env.STATUS_JSON || '{}');
  const expectedTunnelId = process.env.EXPECTED_TUNNEL_ID;
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
  process.exit(localReady && remoteReady ? 0 : 1);
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
  EXPECTED_TUNNEL_ID="$TUNNEL_ID" STATUS_JSON="$status_json" node <<'NODE'
let payload = {};
try { payload = JSON.parse(process.env.STATUS_JSON || '{}'); } catch {}
const expectedTunnelId = process.env.EXPECTED_TUNNEL_ID;
console.error(
  `[codespace] ERROR: managed runtime/platform gate failed (` +
  `tunnel_id=${payload.tunnel_id ?? '<missing>'} expected_tunnel_id=${expectedTunnelId ?? '<missing>'} ` +
  `process_running=${payload.process_running === true} healthy=${payload.healthy === true} ` +
  `ready=${payload.ready === true} runtime_state=${payload.runtime_state ?? '<missing>'} ` +
  `stale=${payload.stale ?? '<missing>'} remote_lookup_attempted=${payload.remote_lookup_attempted === true} ` +
  `remote_error=${payload.remote_error || '<none>'} remote_id=${payload.remote?.id ?? '<missing>'}).`,
);
NODE
  exit 1
fi

# Run diagnostics only after connect + status reconciliation. This prevents a
# stale generated profile from being reported as the active tunnel during
# automatic Codespaces lifecycle startup.
"$BIN" doctor \
  --profile "$PROFILE_NAME" \
  --profile-dir "$PROFILE_DIR" \
  --explain

printf '%s\n' "[codespace] READY: phase=$PHASE tunnel_id=$TUNNEL_ID MCP integration, managed tunnel process, health, and readiness gates passed."
