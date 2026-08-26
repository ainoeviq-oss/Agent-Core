#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/common.sh"

if [[ "$(codespace_anchor_role)" != "anchor" ]]; then
  log_error "Anchor backend discovery can only run on $AGENT_CORE_ANCHOR_CODESPACE_NAME."
  exit 93
fi

interval="$AGENT_CORE_ANCHOR_DISCOVERY_INTERVAL_SECONDS"
if ! [[ "$interval" =~ ^[0-9]+$ ]] || (( interval < 10 || interval > 3600 )); then
  log_error 'AGENT_CORE_ANCHOR_DISCOVERY_INTERVAL_SECONDS must be an integer between 10 and 3600.'
  exit 94
fi

mkdir -p "$AGENT_CORE_CODESPACE_HOME/logs"

while true; do
  if ! bash "$SCRIPT_DIR/discover-anchor-backend.sh"; then
    # Discovery ambiguity/transient GitHub failures must never fabricate a
    # successful switch. The last atomically verified target remains active.
    log_error 'Anchor backend discovery cycle failed; preserving the last verified target.'
  fi
  sleep "$interval"
done
