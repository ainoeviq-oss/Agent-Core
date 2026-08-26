#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/common.sh"

if [[ "$(codespace_anchor_role)" != "anchor" ]]; then
  log_error "Anchor target state can only be changed from $AGENT_CORE_ANCHOR_CODESPACE_NAME."
  exit 93
fi

resolve_nvm || true
ensure_node_runtime || { log_error "Node ${AGENT_CORE_NODE_VERSION} could not be activated."; exit 30; }
cd "$AGENT_CORE_REPO_ROOT"
if [[ ! -f dist/codespace/anchor-target.js || src/codespace/anchor-target.ts -nt dist/codespace/anchor-target.js ]]; then
  npm run build >/dev/null || exit 50
fi
exec "$(command -v node)" dist/codespace/anchor-target.js "$@"
