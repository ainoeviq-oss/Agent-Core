#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/runtime-environment.sh"
codespace_restore_original_path

# Never let a long-lived tmux child retain the parent lifecycle flock.
exec 9>&-

unset CONTROL_PLANE_API_KEY
unset OPENAI_ADMIN_KEY

export CODESPACE_MCP_HTTP_HOST="${CODESPACE_MCP_HTTP_HOST:-127.0.0.1}"
export CODESPACE_MCP_HTTP_PORT="${CODESPACE_MCP_HTTP_PORT:-38765}"
export CODESPACE_MCP_HTTP_URL_FILE="${CODESPACE_MCP_HTTP_URL_FILE:-$ROOT/runtime/state/http-mcp.url}"

exec node "$ROOT/dist/http-server.js"
