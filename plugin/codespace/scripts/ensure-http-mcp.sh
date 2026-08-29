#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION_NAME="${CODESPACE_MCP_HTTP_SESSION:-codespace-mcp-http}"
HOST="${CODESPACE_MCP_HTTP_HOST:-127.0.0.1}"
PORT="${CODESPACE_MCP_HTTP_PORT:-38765}"
URL_FILE="${CODESPACE_MCP_HTTP_URL_FILE:-$ROOT/runtime/state/http-mcp.url}"
LOG_FILE="${CODESPACE_MCP_HTTP_LOG_FILE:-$ROOT/runtime/state/logs/http-mcp.log}"

if [[ "$HOST" != "127.0.0.1" ]]; then
  printf '%s\n' "[codespace] ERROR: HTTP MCP host must be 127.0.0.1." >&2
  exit 1
fi
if [[ ! "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
  printf '%s\n' "[codespace] ERROR: HTTP MCP port must be an integer between 1 and 65535." >&2
  exit 1
fi

MCP_SERVER_URL="http://127.0.0.1:${PORT}/mcp"
HEALTH_URL="http://127.0.0.1:${PORT}/healthz"

command -v tmux >/dev/null 2>&1 || {
  printf '%s\n' "[codespace] ERROR: tmux is required to supervise the loopback MCP server." >&2
  exit 1
}
command -v curl >/dev/null 2>&1 || {
  printf '%s\n' "[codespace] ERROR: curl is required to probe the loopback MCP server." >&2
  exit 1
}
command -v timeout >/dev/null 2>&1 || {
  printf '%s\n' "[codespace] ERROR: timeout is required to bound the MCP protocol probe." >&2
  exit 1
}

mkdir -p "$(dirname "$URL_FILE")" "$(dirname "$LOG_FILE")"

health_ok() {
  curl --noproxy '*' --fail --silent --show-error --max-time 2 "$HEALTH_URL" >/dev/null 2>&1
}

protocol_ok() {
  timeout 15 node "$ROOT/dist/http-probe.js" "$MCP_SERVER_URL" >/dev/null 2>&1
}

url_file_matches() {
  [[ -f "$URL_FILE" ]] && [[ "$(tr -d '\r\n' < "$URL_FILE")" == "$MCP_SERVER_URL" ]]
}

build_is_current() {
  [[ -f "$URL_FILE" ]] || return 1
  ! find "$ROOT/dist" -type f -newer "$URL_FILE" -print -quit | grep -q .
}

if health_ok && url_file_matches && build_is_current && protocol_ok; then
  printf '%s\n' "[codespace] loopback MCP is healthy at $MCP_SERVER_URL"
  exit 0
fi

# Only terminate the tmux session owned by this bridge. An unrelated process on
# the configured port is never adopted or killed.
tmux kill-session -t "$SESSION_NAME" >/dev/null 2>&1 || true
rm -f "$URL_FILE"

printf -v launch_command \
  'exec env CODESPACE_MCP_HTTP_HOST=%q CODESPACE_MCP_HTTP_PORT=%q CODESPACE_MCP_HTTP_URL_FILE=%q bash %q >>%q 2>&1' \
  "$HOST" "$PORT" "$URL_FILE" "$ROOT/scripts/start-http-mcp.sh" "$LOG_FILE"

tmux new-session -d -s "$SESSION_NAME" -c "$ROOT" "$launch_command"

for _ in $(seq 1 80); do
  if health_ok && url_file_matches && build_is_current; then
    if protocol_ok; then
      printf '%s\n' "[codespace] loopback MCP started and protocol probe passed at $MCP_SERVER_URL"
      exit 0
    fi
  fi
  if ! tmux has-session -t "$SESSION_NAME" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

printf '%s\n' "[codespace] ERROR: loopback MCP failed readiness/protocol probe." >&2
if [[ -f "$LOG_FILE" ]]; then
  tail -40 "$LOG_FILE" >&2 || true
fi
exit 1
