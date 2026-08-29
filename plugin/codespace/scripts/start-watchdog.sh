#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/runtime-environment.sh"
codespace_restore_original_path

# Never let the long-running watchdog retain the parent lifecycle flock.
exec 9>&-

unset CONTROL_PLANE_API_KEY
unset OPENAI_ADMIN_KEY

export TUNNEL_CLIENT_STATE_DIR="${TUNNEL_CLIENT_STATE_DIR:-$ROOT/runtime/state}"

exec node "$ROOT/dist/watchdog.js" "$@"
