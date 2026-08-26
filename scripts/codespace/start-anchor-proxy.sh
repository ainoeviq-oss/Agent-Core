#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/common.sh"

if [[ "$(codespace_anchor_role)" != "anchor" ]]; then
  log_error "Anchor proxy can only run on $AGENT_CORE_ANCHOR_CODESPACE_NAME."
  exit 93
fi

cd "$AGENT_CORE_REPO_ROOT"
resolve_nvm || true
ensure_node_runtime || { log_error "Node ${AGENT_CORE_NODE_VERSION} could not be activated."; exit 30; }
NODE_BIN="$(command -v node)"

mkdir -p "$AGENT_CORE_CODESPACE_HOME/anchor" "$AGENT_CORE_CODESPACE_HOME/logs"
ANCHOR_STATE_PATH="$AGENT_CORE_CODESPACE_HOME/anchor/backend.json"
if [[ ! -s "$ANCHOR_STATE_PATH" ]]; then
  "$NODE_BIN" dist/codespace/anchor-target.js local >/dev/null
fi

export AGENT_CORE_ANCHOR_PROXY_HOST="0.0.0.0"
export AGENT_CORE_ANCHOR_PROXY_PORT="$AGENT_CORE_ANCHOR_PUBLIC_PORT"
export AGENT_CORE_ANCHOR_PUBLIC_BASE_URL="$(anchor_public_base_url)"

exec "$NODE_BIN" dist/codespace/anchor-server.js >> "$AGENT_CORE_CODESPACE_HOME/logs/anchor-proxy.log" 2>&1
