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

  node - "$STARTUP" <<'NODE'
const fs = require('node:fs');
const startup = fs.readFileSync(process.argv[2], 'utf8');

const required = [
  'TUNNEL_ID="${CODESPACE_TUNNEL_ID:-}"',
  'TUNNEL_SOURCE="runtime/tunnel.json"',
  'env:CONTROL_PLANE_TUNNEL_ID (legacy fallback)',
  'actualTunnelId === expectedTunnelId',
  "payload.runtime_state === 'ready'",
  'payload.stale === false',
];
for (const needle of required) {
  if (!startup.includes(needle)) {
    console.error(`[codespace] RED: startup hardening check missing: ${needle}`);
    process.exit(1);
  }
}

const canonicalFallback = startup.indexOf('elif [[ -n "$CANONICAL_TUNNEL_ID" ]]');
const legacyFallback = startup.indexOf('elif [[ -n "${CONTROL_PLANE_TUNNEL_ID:-}" ]]');
if (canonicalFallback < 0 || legacyFallback < 0 || canonicalFallback >= legacyFallback) {
  console.error('[codespace] RED: canonical codespace tunnel must precede the legacy tunnel fallback.');
  process.exit(1);
}

const connectIndex = startup.indexOf('runtimes connect');
const statusIndex = startup.indexOf('runtimes status');
const doctorIndex = startup.indexOf('"$BIN" doctor');
if (connectIndex < 0 || statusIndex < 0 || doctorIndex < 0 || !(connectIndex < statusIndex && statusIndex < doctorIndex)) {
  console.error('[codespace] RED: lifecycle order must be connect -> status gate -> doctor.');
  process.exit(1);
}
NODE

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
