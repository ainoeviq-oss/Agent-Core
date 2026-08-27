#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/runtime-environment.sh"
codespace_restore_original_path

unset CONTROL_PLANE_API_KEY
unset OPENAI_ADMIN_KEY

exec node "$ROOT/dist/server.js"
