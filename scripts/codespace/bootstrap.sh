#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/common.sh"

phase="manual"
while (($#)); do
  case "$1" in
    --phase)
      shift
      phase="${1:-}"
      ;;
    *)
      log_error "Unknown bootstrap argument: $1"
      exit 10
      ;;
  esac
  shift || true
done

case "$phase" in
  create|start|attach|manual) ;;
  *) log_error "Unsupported bootstrap phase: $phase"; exit 10 ;;
esac

[[ "$(uname -s)" == "Linux" ]] || {
  log_error 'Codespace bootstrap supports Linux only.'
  exit 10
}
[[ -d "$AGENT_CORE_REPO_ROOT" ]] || {
  log_error "Agent Core repository was not found at $AGENT_CORE_REPO_ROOT"
  exit 10
}

cd "$AGENT_CORE_REPO_ROOT"
log_info "Bootstrap phase: $phase"

missing_packages=()
command -v curl >/dev/null 2>&1 || missing_packages+=(curl)
command -v tmux >/dev/null 2>&1 || missing_packages+=(tmux)
command -v git >/dev/null 2>&1 || missing_packages+=(git)
command -v gh >/dev/null 2>&1 || missing_packages+=(gh)

if (( ${#missing_packages[@]} > 0 )); then
  command -v apt-get >/dev/null 2>&1 || {
    log_error "Required packages are missing and apt-get is unavailable: ${missing_packages[*]}"
    exit 20
  }

  # Keep prerequisite recovery independent from unrelated third-party repositories.
  # Codespaces images may contain optional vendor sources whose expired/missing keys
  # must not block installing Ubuntu runtime tools such as tmux/curl/git.
  apt_primary_source="/etc/apt/sources.list"
  if [[ ! -s "$apt_primary_source" && -s /etc/apt/sources.list.d/ubuntu.sources ]]; then
    apt_primary_source="/etc/apt/sources.list.d/ubuntu.sources"
  fi
  [[ -s "$apt_primary_source" ]] || {
    log_error 'No primary Ubuntu APT source is available for prerequisite recovery.'
    exit 20
  }
  apt_source_args=(
    -o "Dir::Etc::sourcelist=$apt_primary_source"
    -o "Dir::Etc::sourceparts=-"
    -o "APT::Get::List-Cleanup=0"
  )

  log_info "Installing known prerequisites from the primary Ubuntu source only: ${missing_packages[*]}"
  sudo apt-get "${apt_source_args[@]}" update >/dev/null || exit 20
  sudo apt-get "${apt_source_args[@]}" install -y "${missing_packages[@]}" >/dev/null || exit 20
fi

if ! node_version_compatible; then
  if ! resolve_nvm; then
    nvm_target="${HOME:-/home/codespace}/.nvm"
    if [[ ! -s "$nvm_target/nvm.sh" ]]; then
      log_info 'Installing pinned NVM runtime manager.'
      rm -rf "$nvm_target"
      git clone --quiet --depth 1 --branch v0.40.3 https://github.com/nvm-sh/nvm.git "$nvm_target" || exit 30
    fi
    export NVM_DIR="$nvm_target"
    # shellcheck disable=SC1090
    source "$NVM_DIR/nvm.sh"
  fi
fi

ensure_node_runtime || {
  log_error "Unable to activate required Node runtime >=24.15.0 (target $AGENT_CORE_NODE_VERSION)."
  exit 30
}
command -v npm >/dev/null 2>&1 || {
  log_error 'npm is unavailable after Node activation.'
  exit 30
}

if [[ ! -f node_modules/@modelcontextprotocol/sdk/package.json ]]; then
  log_info 'npm dependency marker missing; restoring lockfile dependencies.'
  npm ci || exit 40
elif ! npm ls --depth=0 >/dev/null 2>&1; then
  log_info 'npm dependency tree is inconsistent; restoring from package-lock.json.'
  npm ci || exit 40
else
  log_info 'npm dependency tree is valid.'
fi

log_info 'Running full Agent Core build.'
npm run build || exit 50

mkdir -p \
  "$AGENT_CORE_CODESPACE_HOME/data" \
  "$AGENT_CORE_CODESPACE_HOME/logs" \
  "$AGENT_CORE_CODESPACE_HOME/memory" \
  "$AGENT_CORE_CODESPACE_HOME/execution/runs" \
  "$AGENT_CORE_CODESPACE_HOME/secrets" \
  "$AGENT_CORE_REPO_ROOT/secrets/github"

# Restore the Native GitHub Fabric credential from the Codespaces environment.
# The value is never printed and the destination is ignored by Git.
github_token="${GITHUB_TOKEN:-}"
if [[ -z "$github_token" ]] && command -v gh >/dev/null 2>&1; then
  github_token="$(gh auth token 2>/dev/null || true)"
fi
if [[ -n "$github_token" ]]; then
  umask 077
  printf '%s\n' "$github_token" > "$AGENT_CORE_REPO_ROOT/secrets/github/gh-token.txt"
  chmod 600 "$AGENT_CORE_REPO_ROOT/secrets/github/gh-token.txt"
  log_info 'Native GitHub Fabric credential restored from Codespaces authentication.'
else
  log_info 'GitHub credential was not available; MCP runtime can still start, GitHub Fabric will report unconfigured.'
fi
unset github_token

if [[ -n "${AGENT_CORE_GITHUB_PACKAGES_TOKEN:-}" ]]; then
  umask 077
  printf '%s\n' "$AGENT_CORE_GITHUB_PACKAGES_TOKEN" > "$AGENT_CORE_REPO_ROOT/secrets/github/packages-token.txt"
  chmod 600 "$AGENT_CORE_REPO_ROOT/secrets/github/packages-token.txt"
  log_info 'GitHub Packages credential restored from explicit Codespaces secret.'
fi

key_file="$AGENT_CORE_CODESPACE_HOME/secrets/agent-core-chatgpt-key.txt"
if [[ ! -s "$key_file" ]]; then
  tmp_json="$AGENT_CORE_CODESPACE_HOME/secrets/key-create.$$.json"
  log_info 'Creating a Codespace-specific Agent Core API key without printing its value.'
  AGENT_CORE_DATA_DIR="$AGENT_CORE_CODESPACE_HOME/data" node dist/cli.js create-key codespace-chatgpt > "$tmp_json" || {
    rm -f "$tmp_json"
    exit 40
  }
  node - "$tmp_json" "$key_file" <<'NODE'
const fs = require('node:fs');
const [source, target] = process.argv.slice(2);
const parsed = JSON.parse(fs.readFileSync(source, 'utf8'));
if (typeof parsed.key !== 'string' || !parsed.key.startsWith('agent_core_live_')) process.exit(1);
fs.writeFileSync(target, `${parsed.key}\n`, { mode: 0o600 });
NODE
  rm -f "$tmp_json"
  chmod 600 "$key_file"
  log_info 'Codespace ChatGPT API key created. Value was not printed.'
fi

AGENT_CORE_BOOTSTRAP_ACTIVE=1 bash "$SCRIPT_DIR/ensure-running.sh" --repair --phase "$phase"
