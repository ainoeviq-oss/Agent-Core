#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/common.sh"

backend_url="${1:-}"
if [[ -z "$backend_url" ]]; then
  if [[ "$(codespace_anchor_role)" == "anchor" ]]; then
    backend_url="$(anchor_public_base_url)"
  else
    backend_url="$(public_base_url)" || { log_error 'Unable to resolve current Codespace backend URL.'; exit 93; }
  fi
fi

expected_version="$(source_package_version)" || { log_error 'Unable to resolve source version for stable gateway verification.'; exit 93; }
worker_source="$AGENT_CORE_REPO_ROOT/cloudflare/agent-core-gateway/worker.mjs"
[[ -s "$worker_source" ]] || { log_error "Worker source missing: $worker_source"; exit 93; }

if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  node "$SCRIPT_DIR/stable-gateway-admin.mjs" \
    deploy \
    "${backend_url%/}" \
    "$expected_version" \
    "${AGENT_CORE_STABLE_GATEWAY_BASE_URL%/}" \
    "$AGENT_CORE_CLOUDFLARE_WORKER_NAME" \
    "$worker_source"
else
  ensure_wrangler_oauth_config || { log_error 'Cloudflare Wrangler OAuth credential is unavailable.'; exit 93; }
  npx --yes "wrangler@$AGENT_CORE_WRANGLER_VERSION" \
    deploy "$worker_source" \
    --name "$AGENT_CORE_CLOUDFLARE_WORKER_NAME" \
    --compatibility-date 2026-08-26 >/dev/null
  printf '%s' "${backend_url%/}" | npx --yes "wrangler@$AGENT_CORE_WRANGLER_VERSION" \
    secret put BACKEND_URL \
    --name "$AGENT_CORE_CLOUDFLARE_WORKER_NAME" >/dev/null
  node "$SCRIPT_DIR/stable-gateway-admin.mjs" \
    verify \
    "${backend_url%/}" \
    "$expected_version" \
    "${AGENT_CORE_STABLE_GATEWAY_BASE_URL%/}" \
    "$AGENT_CORE_CLOUDFLARE_WORKER_NAME"
fi
