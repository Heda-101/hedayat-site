# Sourced by the git hooks and setup.sh. Makes `node` resolve to v22+, else exits 1.
_guard_node_ok() {
  local v
  v="$(node -v 2>/dev/null)" || return 1
  v="${v#v}"; v="${v%%.*}"
  [ "$v" -ge 22 ] 2>/dev/null
}

if ! _guard_node_ok; then
  _guard_nvm="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$_guard_nvm/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$_guard_nvm/nvm.sh" >/dev/null 2>&1
    nvm use 22 >/dev/null 2>&1
  fi
  if ! _guard_node_ok; then
    echo "Node 22 required for the commit guard. Install it with nvm (nvm install 22)." >&2
    exit 1
  fi
fi
