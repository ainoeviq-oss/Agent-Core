#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TUNNEL_ID="${1:-}"

if [[ -z "$TUNNEL_ID" ]]; then
  printf '%s\n' "Usage: $0 tunnel_<id>" >&2
  exit 2
fi

if [[ ! "$TUNNEL_ID" =~ ^tunnel_[A-Za-z0-9_-]+$ ]]; then
  printf '%s\n' "[codespace] ERROR: invalid tunnel ID format." >&2
  exit 1
fi

mkdir -p "$ROOT/runtime"
umask 077
printf '{"tunnelId":"%s"}\n' "$TUNNEL_ID" > "$ROOT/runtime/tunnel.json"
chmod 600 "$ROOT/runtime/tunnel.json"
printf '%s\n' "[codespace] tunnel ID saved to runtime/tunnel.json."
