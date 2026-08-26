#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/common.sh"

if [[ "${AGENT_CORE_CODESPACE_SYNC_ENABLED:-1}" != "1" ]]; then
  log_info 'Source synchronization is explicitly disabled.'
  exit 0
fi

remote="${AGENT_CORE_CODESPACE_SYNC_REMOTE:-origin}"
branch="${AGENT_CORE_CODESPACE_SYNC_BRANCH:-main}"

[[ -d "$AGENT_CORE_REPO_ROOT" ]] || {
  log_error "Source sync repository is missing: $AGENT_CORE_REPO_ROOT"
  exit 11
}
command -v git >/dev/null 2>&1 || {
  log_error 'Source sync requires git.'
  exit 11
}
git -C "$AGENT_CORE_REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1 || {
  log_error "Source sync target is not a Git repository: $AGENT_CORE_REPO_ROOT"
  exit 11
}

current_branch="$(git -C "$AGENT_CORE_REPO_ROOT" branch --show-current)"
if [[ "$current_branch" != "$branch" ]]; then
  log_error "Source sync expected branch $branch, found ${current_branch:-detached HEAD}; refusing automatic checkout changes."
  exit 14
fi

if [[ -n "$(git -C "$AGENT_CORE_REPO_ROOT" status --porcelain=v1 --untracked-files=no)" ]]; then
  log_error 'Source sync found tracked local changes; refusing to overwrite or merge them.'
  exit 13
fi

git -C "$AGENT_CORE_REPO_ROOT" remote get-url "$remote" >/dev/null 2>&1 || {
  log_error "Source sync remote is unavailable: $remote"
  exit 12
}

fetch_ok=0
for attempt in 1 2 3; do
  if GIT_TERMINAL_PROMPT=0 git -C "$AGENT_CORE_REPO_ROOT" fetch --quiet --prune "$remote" "$branch"; then
    fetch_ok=1
    break
  fi
  (( attempt < 3 )) && sleep 1
done
if (( fetch_ok != 1 )); then
  log_error "Source sync could not fetch $remote/$branch after bounded retries."
  exit 12
fi

local_sha="$(git -C "$AGENT_CORE_REPO_ROOT" rev-parse HEAD)"
remote_ref="$remote/$branch"
remote_sha="$(git -C "$AGENT_CORE_REPO_ROOT" rev-parse "$remote_ref")"

if [[ "$local_sha" == "$remote_sha" ]]; then
  log_info "Source checkout already matches $remote_ref at $local_sha."
  exit 0
fi

if git -C "$AGENT_CORE_REPO_ROOT" merge-base --is-ancestor "$local_sha" "$remote_sha"; then
  git -C "$AGENT_CORE_REPO_ROOT" merge --ff-only "$remote_ref" >/dev/null || {
    log_error "Source sync could not fast-forward $branch to $remote_ref; local files were preserved."
    exit 17
  }
  updated_sha="$(git -C "$AGENT_CORE_REPO_ROOT" rev-parse HEAD)"
  [[ "$updated_sha" == "$remote_sha" ]] || {
    log_error "Source sync fast-forward verification failed: expected $remote_sha, got $updated_sha."
    exit 17
  }
  log_info "Source sync fast-forwarded $branch from $local_sha to $updated_sha using $remote_ref."
  exit 0
fi

if git -C "$AGENT_CORE_REPO_ROOT" merge-base --is-ancestor "$remote_sha" "$local_sha"; then
  log_error "Source sync found local $branch ahead of $remote_ref; refusing to reset unpublished commits."
  exit 15
fi

log_error "Source sync found $branch diverged from $remote_ref; refusing automatic merge or reset."
exit 16
