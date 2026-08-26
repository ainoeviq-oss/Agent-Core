#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/common.sh"

backend_url="${1:-}"
expected_version="${2:-}"

[[ -n "$AGENT_CORE_STABLE_GATEWAY_BASE_URL" ]] || { log_error 'AGENT_CORE_STABLE_GATEWAY_BASE_URL is unavailable.'; exit 93; }
[[ -n "$AGENT_CORE_CLOUDFLARE_WORKER_NAME" ]] || { log_error 'AGENT_CORE_CLOUDFLARE_WORKER_NAME is unavailable.'; exit 93; }

if [[ -z "$backend_url" ]]; then
  if [[ "$(codespace_anchor_role)" == "anchor" ]]; then
    backend_url="$(anchor_public_base_url)"
  else
    backend_url="$(public_base_url)" || { log_error 'Unable to resolve current Codespace backend URL.'; exit 93; }
  fi
fi

if [[ -z "$expected_version" ]]; then
  expected_version="$(source_package_version)" || { log_error 'Unable to resolve source version for stable gateway verification.'; exit 93; }
fi

if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  node "$SCRIPT_DIR/stable-gateway-admin.mjs" \
    update \
    "${backend_url%/}" \
    "$expected_version" \
    "${AGENT_CORE_STABLE_GATEWAY_BASE_URL%/}" \
    "$AGENT_CORE_CLOUDFLARE_WORKER_NAME"
else
  ensure_wrangler_oauth_config || { log_error 'Cloudflare Wrangler OAuth credential is unavailable.'; exit 93; }
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
