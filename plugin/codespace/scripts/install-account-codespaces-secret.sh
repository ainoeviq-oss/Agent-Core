#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$ROOT/../.." && pwd)"
KEY_FILE="${CODESPACE_CONTROL_PLANE_KEY_FILE:-$REPO_ROOT/secrets/github/CONTROL_PLANE_API_KEY}"
REPO_SLUG=""

while (($#)); do
  case "$1" in
    --repo)
      shift
      REPO_SLUG="${1:-}"
      ;;
    --key-file)
      shift
      KEY_FILE="${1:-}"
      ;;
    *)
      printf '%s\n' "Usage: $0 [--repo OWNER/REPO] [--key-file PATH]" >&2
      exit 2
      ;;
  esac
  shift || true
done

command -v gh >/dev/null 2>&1 || {
  printf '%s\n' '[codespace] ERROR: GitHub CLI (gh) is required.' >&2
  exit 1
}
command -v git >/dev/null 2>&1 || {
  printf '%s\n' '[codespace] ERROR: git is required.' >&2
  exit 1
}
[[ -s "$KEY_FILE" ]] || {
  printf '%s\n' "[codespace] ERROR: runtime credential file is unavailable: $KEY_FILE" >&2
  exit 1
}

if [[ -z "$REPO_SLUG" ]]; then
  origin_url="$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || true)"
  case "$origin_url" in
    https://github.com/*)
      REPO_SLUG="${origin_url#https://github.com/}"
      ;;
    git@github.com:*)
      REPO_SLUG="${origin_url#git@github.com:}"
      ;;
    *)
      printf '%s\n' '[codespace] ERROR: unable to derive GitHub repository from origin; pass --repo OWNER/REPO.' >&2
      exit 1
      ;;
  esac
  REPO_SLUG="${REPO_SLUG%.git}"
fi

if [[ ! "$REPO_SLUG" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  printf '%s\n' '[codespace] ERROR: repository must use OWNER/REPO form.' >&2
  exit 1
fi

# gh encrypts the secret locally before upload. Reading from stdin keeps the
# runtime credential out of argv, shell history, and process listings.
gh secret set CONTROL_PLANE_API_KEY \
  --user \
  --app codespaces \
  --repos "$REPO_SLUG" \
  < "$KEY_FILE"

printf '%s\n' "[codespace] Account-level Codespaces credential installed for $REPO_SLUG."
printf '%s\n' '[codespace] Future Codespaces for this repository will receive it automatically.'
