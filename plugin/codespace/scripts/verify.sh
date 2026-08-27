#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXPECTED_VERSION="v0.0.13"

if [[ "${1:-}" == "--installer-only" ]]; then
  BIN="$ROOT/runtime/bin/tunnel-client"
  if [[ ! -x "$BIN" ]]; then
    printf '%s\n' "[codespace] RED: tunnel-client is not installed." >&2
    exit 1
  fi

  version_output="$($BIN version 2>&1)"
  if ! grep -Fq "$EXPECTED_VERSION" <<<"$version_output"; then
    printf '%s\n' "[codespace] RED: installed tunnel-client is not $EXPECTED_VERSION." >&2
    printf '%s\n' "$version_output" >&2
    exit 1
  fi

  printf '%s\n' "$version_output"
  printf '%s\n' "[codespace] GREEN: tunnel-client $EXPECTED_VERSION verified."
  exit 0
fi

printf '%s\n' "Usage: $0 --installer-only" >&2
exit 2
