#!/usr/bin/env bash
set -euo pipefail

unset CONTROL_PLANE_API_KEY
unset OPENAI_ADMIN_KEY

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$ROOT/dist/server.js"
