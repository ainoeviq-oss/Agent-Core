#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$ROOT/../.." && pwd)"
EXPECTED_SEMVER="0.0.13"

matches_expected_version() {
  local output="$1"
  [[ "$output" =~ ^${EXPECTED_SEMVER//./\.}($|[+\ \(]) ]]
}

if [[ "${1:-}" == "--installer-only" ]]; then
  BIN="$ROOT/runtime/bin/tunnel-client"
  if [[ ! -x "$BIN" ]]; then
    printf '%s\n' "[codespace] RED: tunnel-client is not installed." >&2
    exit 1
  fi

  version_output="$($BIN --version 2>&1 || true)"
  if ! matches_expected_version "$version_output"; then
    printf '%s\n' "[codespace] RED: installed tunnel-client is not semantic version $EXPECTED_SEMVER." >&2
    printf '%s\n' "$version_output" >&2
    exit 1
  fi

  printf '%s\n' "$version_output"
  printf '%s\n' "[codespace] GREEN: tunnel-client v$EXPECTED_SEMVER verified."
  exit 0
fi

if [[ "${1:-}" == "--static" ]]; then
  cd "$REPO_ROOT"

  node <<'NODE'
const fs = require('node:fs');
const config = JSON.parse(fs.readFileSync('.devcontainer/devcontainer.json', 'utf8'));
const expected = {
  postCreateCommand: 'bash scripts/codespace/bootstrap.sh --phase create',
  postStartCommand: 'bash scripts/codespace/bootstrap.sh --phase start',
  postAttachCommand: 'bash scripts/codespace/ensure-running.sh --repair --phase attach',
};
for (const phase of Object.keys(expected)) {
  const value = config[phase];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    console.error(`[codespace] RED: ${phase} must use object form.`);
    process.exit(1);
  }
  if (value.existing !== expected[phase]) {
    console.error(`[codespace] RED: ${phase}.existing changed the pre-existing lifecycle command.`);
    process.exit(1);
  }
  if (typeof value.codespace !== 'string' || !value.codespace.includes('plugin/codespace/scripts/ensure-running.sh')) {
    console.error(`[codespace] RED: ${phase}.codespace is missing the new lifecycle entry.`);
    process.exit(1);
  }
}
NODE

  STARTUP="$ROOT/scripts/ensure-running.sh"
  if [[ ! -f "$STARTUP" ]]; then
    printf '%s\n' "[codespace] RED: managed runtime startup script is missing." >&2
    exit 1
  fi
  if ! grep -Fq -- '--mcp-command' "$STARTUP"; then
    printf '%s\n' "[codespace] RED: managed runtime startup does not use --mcp-command." >&2
    exit 1
  fi
  if grep -Eq '(^|[^[:alnum:]_])(nohup|disown)([^[:alnum:]_]|$)' "$STARTUP"; then
    printf '%s\n' "[codespace] RED: managed runtime startup must not use nohup/disown." >&2
    exit 1
  fi

  printf '%s\n' "[codespace] GREEN: lifecycle composition static checks passed."
  exit 0
fi

printf '%s\n' "Usage: $0 --installer-only | --static" >&2
exit 2
