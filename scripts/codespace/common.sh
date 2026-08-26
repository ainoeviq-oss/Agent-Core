#!/usr/bin/env bash
set -euo pipefail

AGENT_CORE_REPO_ROOT="${AGENT_CORE_REPO_ROOT:-/workspaces/Agent-Core}"
AGENT_CORE_CODESPACE_HOME="${AGENT_CORE_CODESPACE_HOME:-/workspaces/.agent-core-codespace}"
AGENT_CORE_CODESPACE_PORT="${AGENT_CORE_CODESPACE_PORT:-8765}"
AGENT_CORE_ANCHOR_CODESPACE_NAME="${AGENT_CORE_ANCHOR_CODESPACE_NAME:-ominous-xylophone-69xxp4v76vv93xq64}"
AGENT_CORE_ANCHOR_PUBLIC_BASE_URL="${AGENT_CORE_ANCHOR_PUBLIC_BASE_URL:-https://ominous-xylophone-69xxp4v76vv93xq64.app.github.dev}"
AGENT_CORE_ANCHOR_PUBLIC_PORT="${AGENT_CORE_ANCHOR_PUBLIC_PORT:-8765}"
AGENT_CORE_ANCHOR_LOCAL_BACKEND_PORT="${AGENT_CORE_ANCHOR_LOCAL_BACKEND_PORT:-8766}"
AGENT_CORE_ANCHOR_DISCOVERY_INTERVAL_SECONDS="${AGENT_CORE_ANCHOR_DISCOVERY_INTERVAL_SECONDS:-30}"
AGENT_CORE_TMUX_SESSION="${AGENT_CORE_TMUX_SESSION:-agent-core-codespace}"
AGENT_CORE_NODE_VERSION="${AGENT_CORE_NODE_VERSION:-24.16.0}"
AGENT_CORE_STABLE_GATEWAY_BASE_URL="${AGENT_CORE_STABLE_GATEWAY_BASE_URL:-https://agent-core-gateway.joefreccejunior50-d7b.workers.dev}"
AGENT_CORE_CLOUDFLARE_WORKER_NAME="${AGENT_CORE_CLOUDFLARE_WORKER_NAME:-agent-core-gateway}"
AGENT_CORE_STABLE_GATEWAY_REQUIRED="${AGENT_CORE_STABLE_GATEWAY_REQUIRED:-0}"

codespace_anchor_enabled() {
  [[ -n "$AGENT_CORE_ANCHOR_CODESPACE_NAME" ]]
}

codespace_anchor_role() {
  if codespace_anchor_enabled && [[ "${CODESPACE_NAME:-}" == "$AGENT_CORE_ANCHOR_CODESPACE_NAME" ]]; then
    printf 'anchor\n'
  else
    printf 'backend\n'
  fi
}

agent_core_service_port() {
  if [[ "$(codespace_anchor_role)" == "anchor" ]]; then
    printf '%s\n' "$AGENT_CORE_ANCHOR_LOCAL_BACKEND_PORT"
  else
    printf '%s\n' "$AGENT_CORE_CODESPACE_PORT"
  fi
}

anchor_public_base_url() {
  printf '%s\n' "${AGENT_CORE_ANCHOR_PUBLIC_BASE_URL%/}"
}

agent_core_service_host() {
  if [[ "$(codespace_anchor_role)" == "anchor" ]]; then
    printf '127.0.0.1\n'
  else
    printf '0.0.0.0\n'
  fi
}

agent_core_service_session() {
  if [[ "$(codespace_anchor_role)" == "anchor" ]]; then
    printf 'agent-core-codespace-backend\n'
  else
    printf '%s\n' "$AGENT_CORE_TMUX_SESSION"
  fi
}

anchor_proxy_session() {
  printf 'agent-core-codespace-anchor\n'
}

anchor_discovery_session() {
  printf 'agent-core-codespace-anchor-discovery\n'
}

log_info() { printf '[agent-core-codespace] %s\n' "$*"; }
log_error() { printf '[agent-core-codespace] ERROR: %s\n' "$*" >&2; }

stable_gateway_credentials_available() {
  [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]
}

resolve_nvm() {
  local candidates=()
  if [[ -n "${NVM_DIR:-}" ]]; then candidates+=("$NVM_DIR"); fi
  candidates+=("/usr/local/share/nvm" "${HOME:-/home/codespace}/.nvm")

  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -s "$candidate/nvm.sh" ]]; then
      export NVM_DIR="$candidate"
      # shellcheck disable=SC1090
      source "$NVM_DIR/nvm.sh"
      return 0
    fi
  done
  return 1
}

node_version_compatible() {
  command -v node >/dev/null 2>&1 || return 1
  node -e '
    const [major, minor, patch] = process.versions.node.split(".").map(Number);
    const ok = major > 24 || (major === 24 && (minor > 15 || (minor === 15 && patch >= 0)));
    process.exit(ok ? 0 : 1);
  '
}

ensure_node_runtime() {
  if node_version_compatible; then return 0; fi
  resolve_nvm || return 1
  nvm install "$AGENT_CORE_NODE_VERSION" >/dev/null || return 1
  nvm use "$AGENT_CORE_NODE_VERSION" >/dev/null || return 1
  node_version_compatible
}

health_payload_ok() {
  local expected_version="${1:-}"
  node -e '
    let input = "";
    process.stdin.on("data", chunk => input += chunk);
    process.stdin.on("end", () => {
      const expectedVersion = process.argv[1] || "";
      try {
        const value = JSON.parse(input);
        const ok = value.status === "ok"
          && value.memory?.healthy === true
          && value.continuity?.healthy === true
          && value.execution?.healthy === true
          && (!expectedVersion || value.version === expectedVersion);
        process.exit(ok ? 0 : 1);
      } catch {
        process.exit(1);
      }
    });
  ' "$expected_version"
}

source_package_version() {
  node - "$AGENT_CORE_REPO_ROOT/package.json" <<'NODE'
const fs = require('node:fs');
const [packagePath] = process.argv.slice(2);
const parsed = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
if (typeof parsed.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(parsed.version)) process.exit(1);
process.stdout.write(parsed.version);
NODE
}

wait_for_health_port() {
  local port="$1"
  local attempts="${2:-40}"
  local delay="${3:-0.5}"
  local expected_version="${4:-}"
  local health
  local i
  for ((i = 1; i <= attempts; i++)); do
    if health="$(curl -fsS "http://127.0.0.1:${port}/health" 2>/dev/null)"; then
      if printf '%s' "$health" | health_payload_ok "$expected_version"; then
        return 0
      fi
    fi
    sleep "$delay"
  done
  return 1
}

wait_for_service_health() {
  local attempts="${1:-40}"
  local delay="${2:-0.5}"
  local expected_version="${3:-}"
  local service_port="$(agent_core_service_port)"
  local health
  local i
  for ((i = 1; i <= attempts; i++)); do
    if health="$(curl -fsS "http://127.0.0.1:${service_port}/health" 2>/dev/null)"; then
      if printf '%s' "$health" | health_payload_ok "$expected_version"; then
        return 0
      fi
    fi
    sleep "$delay"
  done
  return 1
}

wait_for_local_health() {
  wait_for_service_health "$@"
}

wait_for_anchor_proxy_health() {
  local attempts="${1:-40}"
  local delay="${2:-0.5}"
  local expected_version="${3:-}"
  wait_for_health_port "$AGENT_CORE_ANCHOR_PUBLIC_PORT" "$attempts" "$delay" "$expected_version"
}

codespace_port_json() {
  [[ -n "${CODESPACE_NAME:-}" ]] || return 1
  command -v gh >/dev/null 2>&1 || return 1
  gh codespace ports -c "$CODESPACE_NAME" --json sourcePort,visibility,browseUrl
}

codespace_browse_url() {
  local payload
  payload="$(codespace_port_json)" || return 1
  printf '%s' "$payload" | node -e '
    let input = "";
    process.stdin.on("data", chunk => input += chunk);
    process.stdin.on("end", () => {
      const port = Number(process.argv[1]);
      try {
        const rows = JSON.parse(input);
        const match = Array.isArray(rows) ? rows.find(row => Number(row.sourcePort) === port) : undefined;
        if (!match?.browseUrl) process.exit(1);
        process.stdout.write(String(match.browseUrl));
      } catch {
        process.exit(1);
      }
    });
  ' "$AGENT_CORE_CODESPACE_PORT"
}

codespace_port_visibility() {
  local payload
  payload="$(codespace_port_json)" || return 1
  printf '%s' "$payload" | node -e '
    let input = "";
    process.stdin.on("data", chunk => input += chunk);
    process.stdin.on("end", () => {
      const port = Number(process.argv[1]);
      try {
        const rows = JSON.parse(input);
        const match = Array.isArray(rows) ? rows.find(row => Number(row.sourcePort) === port) : undefined;
        if (!match?.visibility) process.exit(1);
        process.stdout.write(String(match.visibility));
      } catch {
        process.exit(1);
      }
    });
  ' "$AGENT_CORE_CODESPACE_PORT"
}

public_base_url() {
  if [[ -n "${AGENT_CORE_PUBLIC_BASE_URL:-}" ]]; then
    printf '%s\n' "${AGENT_CORE_PUBLIC_BASE_URL%/}"
    return 0
  fi

  local browse
  browse="$(codespace_browse_url 2>/dev/null || true)"
  if [[ -n "$browse" ]]; then
    printf '%s\n' "${browse%/}"
    return 0
  fi

  [[ -n "${CODESPACE_NAME:-}" ]] || return 1
  [[ -n "${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-}" ]] || return 1
  printf 'https://%s-%s.%s\n' \
    "$CODESPACE_NAME" \
    "$AGENT_CORE_CODESPACE_PORT" \
    "$GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN"
}

write_connection_metadata() {
  local base_url="${1%/}"
  local transport="${2:-github-codespaces}"
  local target="$AGENT_CORE_CODESPACE_HOME/connection.json"
  local url_target="$AGENT_CORE_CODESPACE_HOME/mcp-url.txt"
  local tmp="${target}.tmp.$$"
  local url_tmp="${url_target}.tmp.$$"
  local source_commit
  local source_version
  source_commit="$(git -C "$AGENT_CORE_REPO_ROOT" rev-parse HEAD 2>/dev/null)" || return 1
  source_version="$(source_package_version)" || return 1
  mkdir -p "$AGENT_CORE_CODESPACE_HOME"

  node - "$tmp" "$base_url" "$transport" "${CODESPACE_NAME:-}" "$AGENT_CORE_CODESPACE_PORT" "$source_commit" "$source_version" "${AGENT_CORE_CODESPACE_SYNC_REMOTE:-origin}" "${AGENT_CORE_CODESPACE_SYNC_BRANCH:-main}" <<'NODE'
const fs = require('node:fs');
const [target, baseUrl, transport, codespaceName, portRaw, sourceCommit, sourceVersion, sourceRemote, sourceBranch] = process.argv.slice(2);
const port = Number(portRaw);
const payload = {
  codespaceName: codespaceName || null,
  port,
  publicBaseUrl: baseUrl,
  mcpUrl: `${baseUrl}/mcp`,
  healthUrl: `${baseUrl}/health`,
  transport,
  sourceCommit,
  sourceVersion,
  sourceRemote,
  sourceBranch,
  verified: true,
  verifiedAt: new Date().toISOString(),
};
fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
NODE
  printf '%s/mcp\n' "$base_url" > "$url_tmp"
  chmod 600 "$tmp" "$url_tmp"
  mv -f "$tmp" "$target"
  mv -f "$url_tmp" "$url_target"
}
