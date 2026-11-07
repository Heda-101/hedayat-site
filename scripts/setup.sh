#!/usr/bin/env bash
# One-time setup: enable the repo's git hooks and verify the guard's prerequisites.
cd "$(dirname "$0")/.." || exit 1
ROOT="$(pwd)"
rc=0

git config core.hooksPath .githooks && chmod +x .githooks/* || { echo "FAIL  could not enable git hooks"; exit 1; }

gl="$(gitleaks version 2>/dev/null | head -1 | tr -d 'v ')"
if [ -n "$gl" ] && [ "$(printf '%s\n8.19.0\n' "$gl" | sort -V | head -1)" = "8.19.0" ]; then
  echo "ok    gitleaks $gl"
else
  echo "FAIL  gitleaks 8.19 or newer required (brew install gitleaks)"; rc=1
fi

if (. "$ROOT/scripts/guard/node22.sh" && node -v >/dev/null) 2>/dev/null; then
  echo "ok    node 22 reachable"
  node_ok=1
else
  echo "FAIL  Node 22 required (nvm install 22)"; rc=1; node_ok=0
fi

if [ "$node_ok" = 1 ]; then
  msg="$(. "$ROOT/scripts/guard/node22.sh"; node --input-type=module -e "
    import { loadTerms } from '$ROOT/scripts/guard/terms.mjs';
    try { loadTerms(process.env.GUARD_TERMS_FILE || process.env.HOME + '/.config/hedayat-site/blocked-terms.txt'); }
    catch (e) { console.log(e.code === 'TERMS_MISSING' || e.code === 'TERMS_EMPTY' ? 'create ~/.config/hedayat-site/blocked-terms.txt with at least one term' : String(e.message || e.code)); process.exit(1); }
  " 2>&1)" && echo "ok    blocked-terms file present and valid" || { echo "FAIL  $msg"; rc=1; }
else
  echo "FAIL  blocked-terms file not checked (needs Node 22)"; rc=1
fi
exit $rc
