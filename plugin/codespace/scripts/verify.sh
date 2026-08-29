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
  if (config[phase] !== expected[phase]) {
    console.error(`[codespace] RED: ${phase} must use the deterministic canonical lifecycle command.`);
    process.exit(1);
  }
}
NODE

  LEGACY_STARTUP="$REPO_ROOT/scripts/codespace/ensure-running.sh"
  if ! grep -Fq 'plugin/codespace/scripts/ensure-running.sh' "$LEGACY_STARTUP"; then
    printf '%s\n' "[codespace] RED: canonical Codespaces lifecycle does not chain the codespace bridge." >&2
    exit 1
  fi

  STARTUP="$ROOT/scripts/ensure-running.sh"
  if [[ ! -f "$STARTUP" ]]; then
    printf '%s\n' "[codespace] RED: managed runtime startup script is missing." >&2
    exit 1
  fi

  node - "$STARTUP" <<'NODE'
const fs = require('node:fs');
const startup = fs.readFileSync(process.argv[2], 'utf8');

const required = [
  'RUNTIME_API_KEY_FILE="$REPO_ROOT/secrets/github/CONTROL_PLANE_API_KEY"',
  'RUNTIME_API_KEY_REF="file:$RUNTIME_API_KEY_FILE"',
  '--runtime-api-key "$RUNTIME_API_KEY_REF"',
  'TRACKED_TUNNEL_ID',
  'config/tunnel.defaults.json',
  'TUNNEL_ID="${CODESPACE_TUNNEL_ID:-}"',
  'TUNNEL_SOURCE="config/tunnel.defaults.json"',
  'env:CONTROL_PLANE_TUNNEL_ID (legacy fallback)',
  'flock -w 120 9',
  'exec 9>&-',
  'runtimes stop "$ALIAS"',
  'remote_lookup_attempted === true',
  "payload.remote_lookup_auth_ref.startsWith('file:')",
  'payload.remote?.id === expectedTunnelId',
  'payload.tunnel_id === expectedTunnelId',
  "payload.runtime_state === 'ready'",
  'payload.stale === false',
  'ensure-http-mcp.sh',
  '--mcp-server-url "$MCP_SERVER_URL"',
  "payload.process?.target_kind === 'server_url'",
  'payload.process?.target_value === expectedMcpServerUrl',
  '$ROOT/dist/http-server.js',
  '$ROOT/dist/http-probe.js',
  '$ROOT/dist/watchdog.js',
  'FORCE_RECONNECT=false',
  '--force-reconnect)',
  'FORCE_RECONNECT=true',
  'CODESPACE_WATCHDOG_ACTIVE',
  'codespace-bridge-watchdog',
  'start-watchdog.sh',
];
for (const needle of required) {
  if (!startup.includes(needle)) {
    console.error(`[codespace] RED: startup hardening check missing: ${needle}`);
    process.exit(1);
  }
}

const trackedFallback = startup.indexOf('elif [[ -n "$TRACKED_TUNNEL_ID" ]]');
const canonicalFallback = startup.indexOf('elif [[ -n "$CANONICAL_TUNNEL_ID" ]]');
const legacyFallback = startup.indexOf('elif [[ -n "${CONTROL_PLANE_TUNNEL_ID:-}" ]]');
if (
  trackedFallback < 0 || canonicalFallback < 0 || legacyFallback < 0 ||
  !(trackedFallback < canonicalFallback && canonicalFallback < legacyFallback)
) {
  console.error('[codespace] RED: tracked tunnel default must precede runtime and legacy fallbacks.');
  process.exit(1);
}

const localProbeIndex = startup.indexOf('bash "$ROOT/scripts/ensure-http-mcp.sh"');
const stopIndex = startup.indexOf('runtimes stop "$ALIAS"');
const connectIndex = startup.indexOf('runtimes connect');
const statusIndex = startup.indexOf('runtimes status');
const doctorIndex = startup.indexOf('"$BIN" doctor');
const watchdogPreflightIndex = startup.indexOf('start-watchdog.sh" --once');
const readyIndex = startup.indexOf('[codespace] READY:');
if (
  localProbeIndex < 0 || stopIndex < 0 || connectIndex < 0 || statusIndex < 0 ||
  doctorIndex < 0 || watchdogPreflightIndex < 0 || readyIndex < 0 ||
  !(localProbeIndex < stopIndex && stopIndex < connectIndex && connectIndex < statusIndex &&
    statusIndex < doctorIndex && doctorIndex < watchdogPreflightIndex && watchdogPreflightIndex < readyIndex)
) {
  console.error('[codespace] RED: lifecycle order must be local MCP -> stop -> connect -> status -> doctor -> watchdog -> READY.');
  process.exit(1);
}
NODE

  HTTP_ENSURE="$ROOT/scripts/ensure-http-mcp.sh"
  HTTP_START="$ROOT/scripts/start-http-mcp.sh"
  WATCHDOG_START="$ROOT/scripts/start-watchdog.sh"
  for script in "$HTTP_ENSURE" "$HTTP_START" "$WATCHDOG_START"; do
    if [[ ! -x "$script" ]]; then
      printf '%s\n' "[codespace] RED: required HTTP MCP lifecycle script is missing or not executable: $script" >&2
      exit 1
    fi
    bash -n "$script"
  done
  if ! grep -Fq -- '--mcp-server-url "$MCP_SERVER_URL"' "$STARTUP"; then
    printf '%s\n' "[codespace] RED: managed runtime startup does not use the probed loopback MCP URL." >&2
    exit 1
  fi
  if grep -Fq -- '--mcp-command "bash $ROOT/scripts/start-mcp.sh"' "$STARTUP"; then
    printf '%s\n' "[codespace] RED: managed runtime startup must not use readiness-blind stdio." >&2
    exit 1
  fi
  if ! grep -Fq 'dist/http-probe.js' "$HTTP_ENSURE"; then
    printf '%s\n' "[codespace] RED: HTTP MCP supervisor lacks a protocol probe." >&2
    exit 1
  fi
  if ! grep -Fq 'build_is_current' "$HTTP_ENSURE" || ! grep -Fq 'find "$ROOT/dist" -type f -newer "$URL_FILE"' "$HTTP_ENSURE"; then
    printf '%s\n' "[codespace] RED: HTTP MCP supervisor cannot detect stale compiled server code." >&2
    exit 1
  fi
  if ! grep -Fq 'exec 9>&-' "$HTTP_START" || ! grep -Fq 'unset CONTROL_PLANE_API_KEY' "$HTTP_START"; then
    printf '%s\n' "[codespace] RED: HTTP MCP child retains a lifecycle lock or control-plane credential." >&2
    exit 1
  fi
  if ! grep -Fq 'exec 9>&-' "$WATCHDOG_START" || ! grep -Fq 'unset CONTROL_PLANE_API_KEY' "$WATCHDOG_START" || ! grep -Fq 'dist/watchdog.js' "$WATCHDOG_START"; then
    printf '%s\n' "[codespace] RED: watchdog entrypoint is missing, lock-retaining, or not credential-isolated." >&2
    exit 1
  fi
  if grep -Eq '(^|[^[:alnum:]_])(nohup|disown)([^[:alnum:]_]|$)' "$STARTUP"; then
    printf '%s\n' "[codespace] RED: managed runtime startup must not use nohup/disown." >&2
    exit 1
  fi

  printf '%s\n' "[codespace] GREEN: lifecycle composition, probed HTTP MCP, and watchdog static checks passed."
  exit 0
fi

printf '%s\n' "Usage: $0 --installer-only | --static" >&2
exit 2
