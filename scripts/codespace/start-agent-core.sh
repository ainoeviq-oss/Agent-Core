#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/common.sh"

cd "$AGENT_CORE_REPO_ROOT"
resolve_nvm || true
ensure_node_runtime || {
  log_error "Node ${AGENT_CORE_NODE_VERSION} could not be activated."
  exit 30
}
NODE_BIN="$(command -v node)"

mkdir -p \
  "$AGENT_CORE_CODESPACE_HOME/data" \
  "$AGENT_CORE_CODESPACE_HOME/logs" \
  "$AGENT_CORE_CODESPACE_HOME/memory" \
  "$AGENT_CORE_CODESPACE_HOME/execution/runs" \
  "$AGENT_CORE_CODESPACE_HOME/secrets"

export AGENT_CORE_HOST="0.0.0.0"
export AGENT_CORE_PORT="$AGENT_CORE_CODESPACE_PORT"
export AGENT_CORE_DATA_DIR="$AGENT_CORE_CODESPACE_HOME/data"
export AGENT_CORE_LOG_DIR="$AGENT_CORE_CODESPACE_HOME/logs"
export AGENT_CORE_CAPABILITY_DIR="$AGENT_CORE_REPO_ROOT/capabilities"
export AGENT_CORE_ALLOWED_ROOTS="$AGENT_CORE_REPO_ROOT"
export AGENT_CORE_MEMORY_ENABLED="true"
export AGENT_CORE_MEMORY_DB_PATH="$AGENT_CORE_CODESPACE_HOME/memory/agent-core-memory.sqlite"
export AGENT_CORE_EXECUTION_ENABLED="true"
export AGENT_CORE_EXECUTION_DB_PATH="$AGENT_CORE_CODESPACE_HOME/execution/agent-core-execution.sqlite"
export AGENT_CORE_EXECUTION_LOG_ROOT="$AGENT_CORE_CODESPACE_HOME/execution/runs"
export AGENT_CORE_GITHUB_TOKEN_FILE="$AGENT_CORE_REPO_ROOT/secrets/github/gh-token.txt"
export AGENT_CORE_GITHUB_PACKAGES_TOKEN_FILE="$AGENT_CORE_REPO_ROOT/secrets/github/packages-token.txt"

echo $$ > "$AGENT_CORE_CODESPACE_HOME/agent-core.pid"
exec "$NODE_BIN" dist/index.js >> "$AGENT_CORE_CODESPACE_HOME/logs/agent-core.log" 2>&1
