#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${1:-}" == "--installer-only" ]]; then
  if [[ ! -x "$ROOT/runtime/bin/tunnel-client" ]]; then
    printf '%s\n' "[codespace] RED: tunnel-client is not installed." >&2
    exit 1
  fi
  "$ROOT/runtime/bin/tunnel-client" version
  exit 0
fi

printf '%s\n' "Usage: $0 --installer-only" >&2
exit 2
