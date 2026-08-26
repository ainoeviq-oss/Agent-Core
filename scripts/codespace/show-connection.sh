#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/common.sh"

connection="$AGENT_CORE_CODESPACE_HOME/connection.json"
url_file="$AGENT_CORE_CODESPACE_HOME/mcp-url.txt"

[[ -s "$connection" && -s "$url_file" ]] || {
  log_error 'Verified connection metadata is not available. Run npm run codespace:repair.'
  exit 1
}

printf 'Agent Core Codespace MCP URL:\n'
cat "$url_file"
printf '\n'
node - "$connection" <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
console.log(`Transport: ${value.transport}`);
console.log(`Verified: ${value.verified === true ? 'yes' : 'no'}`);
console.log(`Verified at: ${value.verifiedAt ?? 'unknown'}`);
NODE
