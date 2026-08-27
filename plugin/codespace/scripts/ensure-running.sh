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

if [[ -z "${CONTROL_PLANE_API_KEY:-}" ]]; then
  printf '%s\n' "CONTROL_PLANE_API_KEY" >&2
  exit 1
fi

TUNNEL_ID="${CODESPACE_TUNNEL_ID:-${CONTROL_PLANE_TUNNEL_ID:-}}"
if [[ -z "$TUNNEL_ID" && -f "$ROOT/runtime/tunnel.json" ]]; then
  TUNNEL_ID="$(node -e '
const fs = require("node:fs");
const file = process.argv[1];
try {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (typeof value.tunnelId === "string") process.stdout.write(value.tunnelId);
} catch {}
' "$ROOT/runtime/tunnel.json")"
fi

if [[ -z "$TUNNEL_ID" ]]; then
  printf '%s\n' "Run plugin/codespace/scripts/configure-tunnel.sh with the tunnel ID shown in OpenAI Platform Tunnels." >&2
  exit 1
fi

if [[ ! "$TUNNEL_ID" =~ ^tunnel_[A-Za-z0-9_-]+$ ]]; then
  printf '%s\n' "[codespace] ERROR: invalid tunnel ID format." >&2
  exit 1
fi

bash "$ROOT/scripts/install-tunnel-client.sh"

needs_build=false
if [[ ! -f "$ROOT/dist/server.js" ]]; then
  needs_build=true
elif find "$ROOT/src" -type f -name '*.ts' -newer "$ROOT/dist/server.js" -print -quit | grep -q .; then
  needs_build=true
fi

if [[ "$needs_build" == true ]]; then
  (
    cd "$REPO_ROOT"
    npx tsc -p plugin/codespace/tsconfig.json
  )
fi

(
  cd "$REPO_ROOT"
  NODE_ENV=test npx vitest run plugin/codespace/tests/mcp.integration.test.ts
)

mkdir -p "$PROFILE_DIR" "$STATE_DIR"
export TUNNEL_CLIENT_STATE_DIR="$STATE_DIR"

if [[ -f "$PROFILE_FILE" ]]; then
  "$BIN" doctor \
    --profile "$PROFILE_NAME" \
    --profile-dir "$PROFILE_DIR" \
    --explain
fi

connect_rc=0
"$BIN" runtimes connect \
  --alias "$ALIAS" \
  --tunnel-id "$TUNNEL_ID" \
  --profile "$PROFILE_NAME" \
  --profile-dir "$PROFILE_DIR" \
  --runtime-api-key env:CONTROL_PLANE_API_KEY \
  --mcp-command "bash $ROOT/scripts/start-mcp.sh" \
  >/dev/null || connect_rc=$?

if [[ "$connect_rc" -ne 0 && "$connect_rc" -ne 2 ]]; then
  printf '%s\n' "[codespace] ERROR: managed runtime connect failed." >&2
  exit "$connect_rc"
fi

status_json="$($BIN runtimes status "$ALIAS" --json)"
STATUS_JSON="$status_json" node <<'NODE'
const payload = JSON.parse(process.env.STATUS_JSON || '{}');
const running = payload.process_running === true;
const healthy = payload.healthy === true;
const ready = payload.ready === true;
if (!running || !healthy || !ready) {
  console.error(`[codespace] ERROR: managed runtime gate failed (process_running=${running} healthy=${healthy} ready=${ready}).`);
  process.exit(1);
}
NODE

printf '%s\n' "[codespace] READY: MCP integration, managed tunnel process, health, and readiness gates passed."
