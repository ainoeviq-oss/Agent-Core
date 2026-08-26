#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/common.sh"

phase="manual"
repair=0
while (($#)); do
  case "$1" in
    --repair) repair=1 ;;
    --phase)
      shift
      phase="${1:-}"
      ;;
    *) log_error "Unknown repair argument: $1"; exit 10 ;;
  esac
  shift || true
done

case "$phase" in
  create|start|attach|manual) ;;
  *) log_error "Unsupported repair phase: $phase"; exit 10 ;;
esac

[[ -d "$AGENT_CORE_REPO_ROOT" ]] || { log_error "Missing repository: $AGENT_CORE_REPO_ROOT"; exit 10; }
[[ -n "${CODESPACE_NAME:-}" ]] || { log_error 'CODESPACE_NAME is unavailable.'; exit 10; }
cd "$AGENT_CORE_REPO_ROOT"

needs_bootstrap=0
command -v curl >/dev/null 2>&1 || needs_bootstrap=1
command -v tmux >/dev/null 2>&1 || needs_bootstrap=1
command -v gh >/dev/null 2>&1 || needs_bootstrap=1
node_version_compatible || needs_bootstrap=1
[[ -f node_modules/@modelcontextprotocol/sdk/package.json ]] || needs_bootstrap=1

if (( needs_bootstrap == 1 )); then
  if [[ "${AGENT_CORE_BOOTSTRAP_ACTIVE:-0}" == "1" ]]; then
    log_error 'Bootstrap completed but one or more required prerequisites are still unavailable.'
    exit 20
  fi
  log_info 'Runtime prerequisite or dependency is missing; delegating to full bootstrap.'
  exec bash "$SCRIPT_DIR/bootstrap.sh" --phase start
fi

if [[ "${AGENT_CORE_BOOTSTRAP_ACTIVE:-0}" != "1" ]]; then
  source_before="$(git rev-parse HEAD 2>/dev/null)" || {
    log_error 'Unable to resolve the current source commit before synchronization.'
    exit 11
  }
  if bash "$SCRIPT_DIR/sync-source.sh"; then
    :
  else
    sync_status=$?
    exit "$sync_status"
  fi
  source_after="$(git rev-parse HEAD 2>/dev/null)" || {
    log_error 'Unable to resolve the synchronized source commit.'
    exit 11
  }
  if [[ "$source_after" != "$source_before" ]]; then
    log_info 'Source checkout changed during synchronization; restarting bootstrap from the synchronized source.'
    exec bash "$SCRIPT_DIR/bootstrap.sh" --phase "$phase"
  fi
fi

expected_source_version="$(source_package_version)" || {
  log_error 'Unable to resolve Agent Core package version from synchronized source.'
  exit 50
}
restart_required="${AGENT_CORE_FORCE_RESTART:-0}"
build_required=0
if [[ ! -f dist/index.js ]]; then
  build_required=1
elif find src -type f -newer dist/index.js -print -quit | grep -q .; then
  build_required=1
elif [[ package.json -nt dist/index.js || package-lock.json -nt dist/index.js ]]; then
  build_required=1
fi

if (( build_required == 1 )); then
  log_info 'Build output is missing or stale; rebuilding Agent Core.'
  npm run build || exit 50
  restart_required=1
fi

start_supervisor() {
  tmux new-session -d -s "$AGENT_CORE_TMUX_SESSION" "bash \"$SCRIPT_DIR/start-agent-core.sh\""
}

if [[ "$restart_required" == "1" ]] && tmux has-session -t "$AGENT_CORE_TMUX_SESSION" 2>/dev/null; then
  log_info 'Restarting Agent Core supervisor to activate the synchronized build.'
  tmux kill-session -t "$AGENT_CORE_TMUX_SESSION" 2>/dev/null || true
  start_supervisor || exit 60
elif ! tmux has-session -t "$AGENT_CORE_TMUX_SESSION" 2>/dev/null; then
  log_info 'Starting Agent Core supervisor session.'
  start_supervisor || exit 60
fi

if ! wait_for_local_health 40 0.5 "$expected_source_version"; then
  log_error "Local health did not become ready at synchronized source version $expected_source_version; performing one controlled service restart."
  tmux kill-session -t "$AGENT_CORE_TMUX_SESSION" 2>/dev/null || true
  start_supervisor || exit 60
  if ! wait_for_local_health 40 0.5 "$expected_source_version"; then
    log_error "Agent Core local health/version gate failed after restart. See $AGENT_CORE_CODESPACE_HOME/logs/agent-core.log"
    exit 70
  fi
fi
log_info "Local Agent Core health is verified at source version $expected_source_version."

browse_url=""
for _ in $(seq 1 60); do
  browse_url="$(codespace_browse_url 2>/dev/null || true)"
  [[ -n "$browse_url" ]] && break
  sleep 1
done
if [[ -z "$browse_url" ]]; then
  log_error "Agent Core is listening locally but GitHub Codespaces has not registered forwarded port $AGENT_CORE_CODESPACE_PORT."
  exit 80
fi

visibility="$(codespace_port_visibility 2>/dev/null || true)"
if [[ "$visibility" != "public" ]]; then
  log_info "Setting forwarded port $AGENT_CORE_CODESPACE_PORT visibility to public."
  gh codespace ports visibility "$AGENT_CORE_CODESPACE_PORT:public" -c "$CODESPACE_NAME" >/dev/null || exit 81
  for _ in $(seq 1 20); do
    visibility="$(codespace_port_visibility 2>/dev/null || true)"
    [[ "$visibility" == "public" ]] && break
    sleep 1
  done
fi
[[ "$visibility" == "public" ]] || {
  log_error "Forwarded port $AGENT_CORE_CODESPACE_PORT is not public after repair."
  exit 81
}
log_info "Forwarded port $AGENT_CORE_CODESPACE_PORT is public."

base_url="$(public_base_url)" || {
  log_error 'Unable to resolve public Agent Core base URL.'
  exit 90
}
base_url="${base_url%/}"

public_health=""
for _ in $(seq 1 30); do
  if public_health="$(curl -fsS "$base_url/health" 2>/dev/null)"; then
    if printf '%s' "$public_health" | health_payload_ok "$expected_source_version"; then
      break
    fi
  fi
  public_health=""
  sleep 1
done
[[ -n "$public_health" ]] || {
  log_error "Public health failed at $base_url/health"
  exit 90
}

oauth_json="$(curl -fsS "$base_url/.well-known/oauth-authorization-server" 2>/dev/null)" || {
  log_error 'OAuth metadata endpoint is unavailable.'
  exit 91
}
printf '%s' "$oauth_json" | node -e '
  let input = "";
  process.stdin.on("data", chunk => input += chunk);
  process.stdin.on("end", () => {
    const expected = process.argv[1];
    try {
      const value = JSON.parse(input);
      process.exit(value.issuer === expected ? 0 : 1);
    } catch {
      process.exit(1);
    }
  });
' "$base_url" || {
  log_error "OAuth issuer does not match verified public base URL: $base_url"
  exit 91
}

mcp_status="$(curl -sS -o /dev/null -w '%{http_code}' "$base_url/mcp" 2>/dev/null || true)"
[[ "$mcp_status" == "401" ]] || {
  log_error "Expected unauthenticated /mcp to return 401, got ${mcp_status:-no-response}."
  exit 92
}

transport="github-codespaces"
[[ -n "${AGENT_CORE_PUBLIC_BASE_URL:-}" ]] && transport="stable-front-door"
write_connection_metadata "$base_url" "$transport"

log_info 'READY: all local, forwarding, public-health, OAuth, and MCP-auth gates passed.'
printf 'Agent Core Codespace MCP URL: %s/mcp\n' "$base_url"
