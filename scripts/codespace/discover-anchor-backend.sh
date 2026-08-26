#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/common.sh"

if [[ "$(codespace_anchor_role)" != "anchor" ]]; then
  log_error "Automatic backend discovery runs only on anchor $AGENT_CORE_ANCHOR_CODESPACE_NAME."
  exit 93
fi
command -v gh >/dev/null 2>&1 || { log_error 'GitHub CLI is unavailable.'; exit 20; }
resolve_nvm || true
ensure_node_runtime || { log_error "Node ${AGENT_CORE_NODE_VERSION} could not be activated."; exit 30; }
cd "$AGENT_CORE_REPO_ROOT"
if [[ ! -f dist/codespace/anchor-discovery.js || src/codespace/anchor-discovery.ts -nt dist/codespace/anchor-discovery.js ]]; then
  npm run build >/dev/null || exit 50
fi
exec "$(command -v node)" dist/codespace/anchor-discovery.js
