#!/usr/bin/env bash

codespace_prepare_process_runtime() {
  local package_root="$1"
  local shim_dir="$package_root/runtime/no-tmux-bin"
  local shim="$shim_dir/tmux"

  mkdir -p "$shim_dir"
  cat > "$shim" <<'SHIM'
#!/bin/sh
exit 127
SHIM
  chmod 0700 "$shim"

  if [[ -z "${CODESPACE_ORIGINAL_PATH+x}" ]]; then
    export CODESPACE_ORIGINAL_PATH="$PATH"
  fi
  export PATH="$shim_dir:$PATH"
}

codespace_restore_original_path() {
  if [[ -n "${CODESPACE_ORIGINAL_PATH+x}" ]]; then
    export PATH="$CODESPACE_ORIGINAL_PATH"
    unset CODESPACE_ORIGINAL_PATH
  fi
}
