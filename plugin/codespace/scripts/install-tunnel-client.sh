#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="v0.0.13"
BASE_URL="https://github.com/openai/tunnel-client/releases/download/${VERSION}"
BIN_DIR="$ROOT/runtime/bin"
BIN="$BIN_DIR/tunnel-client"

if [[ "$(uname -s)" != "Linux" ]]; then
  printf '%s\n' "[codespace] ERROR: tunnel-client installer currently supports Linux Codespaces only." >&2
  exit 1
fi

for command_name in curl unzip sha256sum awk find install mktemp; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf '%s\n' "[codespace] ERROR: required command is missing: $command_name" >&2
    exit 1
  fi
done

if [[ -x "$BIN" ]]; then
  installed_version="$($BIN version 2>&1 || true)"
  if grep -Fq "$VERSION" <<<"$installed_version"; then
    printf '%s\n' "[codespace] tunnel-client $VERSION already installed."
    exit 0
  fi
fi

case "$(uname -m)" in
  x86_64|amd64)
    ASSET="tunnel-client-v0.0.13-linux-amd64.zip"
    PINNED_SHA256="e71f37b424126513173d5e3590687c0b5ccf6e8ef3fba900104d1f8c60dad906"
    ;;
  aarch64|arm64)
    ASSET="tunnel-client-v0.0.13-linux-arm64.zip"
    PINNED_SHA256="9d214a805bec213a3a156dc2a4460a6dfe2f35b0c00ba20609d002bf5e6469f8"
    ;;
  *)
    printf '%s\n' "[codespace] ERROR: unsupported Linux architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

curl --proto '=https' --tlsv1.2 -fsSL --retry 3 \
  "$BASE_URL/SHA256SUMS.txt" \
  -o "$tmp_dir/SHA256SUMS.txt"
curl --proto '=https' --tlsv1.2 -fsSL --retry 3 \
  "$BASE_URL/$ASSET" \
  -o "$tmp_dir/$ASSET"

manifest_sha256="$(awk -v target="$ASSET" '
  {
    name=$NF
    sub(/^\*/, "", name)
    if (name == target) {
      print $1
      exit
    }
  }
' "$tmp_dir/SHA256SUMS.txt")"

if [[ -z "$manifest_sha256" ]]; then
  printf '%s\n' "[codespace] ERROR: official SHA256SUMS.txt has no entry for $ASSET." >&2
  exit 1
fi

if [[ "$manifest_sha256" != "$PINNED_SHA256" ]]; then
  printf '%s\n' "[codespace] ERROR: official manifest hash does not match the pinned $VERSION hash." >&2
  exit 1
fi

(
  cd "$tmp_dir"
  printf '%s  %s\n' "$manifest_sha256" "$ASSET" | sha256sum -c -
)

mkdir -p "$tmp_dir/extract"
unzip -q "$tmp_dir/$ASSET" -d "$tmp_dir/extract"
extracted_binary="$(find "$tmp_dir/extract" -type f -name tunnel-client -print -quit)"

if [[ -z "$extracted_binary" ]]; then
  printf '%s\n' "[codespace] ERROR: verified release archive did not contain tunnel-client." >&2
  exit 1
fi

mkdir -p "$BIN_DIR"
staged_bin="$BIN_DIR/.tunnel-client.$$.new"
install -m 0755 "$extracted_binary" "$staged_bin"
mv -f "$staged_bin" "$BIN"

version_output="$($BIN version 2>&1)"
if ! grep -Fq "$VERSION" <<<"$version_output"; then
  rm -f "$BIN"
  printf '%s\n' "[codespace] ERROR: installed tunnel-client did not report $VERSION." >&2
  exit 1
fi

printf '%s\n' "[codespace] installed tunnel-client $VERSION from verified official release asset."
