#!/usr/bin/env bash
# End-to-end proof that each guard layer blocks. Builds throwaway repos (never touches this one),
# prints one "PASS <layer>: <case>" line per case, and exits 1 if any case misbehaves.
# It never calls the real claude CLI: the AI review always goes through a fixture reviewer.
set -u

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SELF_DIR/../.." && pwd)"
. "$SELF_DIR/node22.sh" || exit 1

FIX="$ROOT/tests/guard/fixtures"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/guard-selftest.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

TERM_TEXT='Selftest Client Co'
printf '%s\n' "$TERM_TEXT" >"$WORK/terms.txt"
FAILS=0

# Every command below runs against the selftest's own terms file, never the developer's real one.
export GUARD_TERMS_FILE="$WORK/terms.txt" GUARD_AI_CMD="$FIX/fake-claude-pass.sh" GUARD_TTY=/nonexistent

# Git must not pick up the developer's own config; Claude Code must be off unless a case turns it on.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0
unset CLAUDECODE

pass() { printf 'PASS %s: %s\n' "$1" "$2"; }
fail() { printf 'FAIL %s: %s (%s)\n' "$1" "$2" "$3"; FAILS=$((FAILS + 1)); }

# expect <layer> <case> <want-exit> <got-exit> [output]
expect() {
  if [ "$3" = "$4" ]; then pass "$1" "$2"; else fail "$1" "$2" "wanted exit $3, got $4"; printf '%s\n' "${5:-}" | sed 's/^/    | /' | head -15; fi
}

# Runs a command with a fully controlled guard environment. $AI picks the fixture reviewer
# (default: pass) and $CC sets CLAUDECODE ("" = unset, so layer 1 never reaches the AI review).
run_env() {
  local cc=()
  if [ -n "${CC:-}" ]; then cc=(CLAUDECODE="$CC"); else cc=(-u CLAUDECODE); fi
  env "${cc[@]}" \
    GUARD_TERMS_FILE="${TERMS:-$WORK/terms.txt}" \
    GUARD_AI_CMD="$FIX/fake-claude-${AI:-pass}.sh" \
    GUARD_TTY="${TTY_OVERRIDE:-/nonexistent}" \
    "$@"
}

# mkrepo <name>: a repo with a bare origin, this repo's guard files and live hooks.
mkrepo() {
  local d="$WORK/$1" o="$WORK/$1-origin.git"
  mkdir -p "$d" && git init -q -b main "$d" && git init -q --bare -b main "$o" || return 1
  cp -R "$ROOT/.githooks" "$d/.githooks"
  mkdir -p "$d/scripts" "$d/.claude" && cp -R "$ROOT/scripts/guard" "$d/scripts/guard"
  cp "$ROOT/CONTENT-GUIDELINES.md" "$d/CONTENT-GUIDELINES.md"
  cp "$ROOT/.claude/settings.json" "$d/.claude/settings.json"
  (
    cd "$d" || exit 1
    git config user.name 'Selftest'
    git config user.email 'selftest@example.invalid'
    git config commit.gpgsign false
    git config core.hooksPath .githooks
    git remote add origin "$o"
    printf '.githooks\nscripts\n.claude\nCONTENT-GUIDELINES.md\n' >>.git/info/exclude
    printf 'base\n' >README.md
    git add README.md
    git commit -q -m 'base' && git push -q origin main
  ) >/dev/null 2>&1
}

# The exact command Claude Code runs for the PreToolUse hook, read from settings.json.
HOOK_CMD="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).hooks.PreToolUse[0].hooks[0].command)' "$ROOT/.claude/settings.json")"
[ -n "$HOOK_CMD" ] || { echo "FAIL setup: could not read the hook command from .claude/settings.json"; exit 1; }

# hook <repo> <bash-command>: feed PreToolUse JSON to the hook the way Claude Code does.
hook() {
  local repo="$1" json
  json="$(node -e 'process.stdout.write(JSON.stringify({tool_name:"Bash",tool_input:{command:process.argv[1]},cwd:process.argv[2]}))' "$2" "$repo")"
  (cd "$repo" && printf '%s' "$json" | run_env CLAUDE_PROJECT_DIR="$repo" /bin/sh -c "$HOOK_CMD")
}

# A fake secret built at run time; no token literal exists in this file.
fake_token() { printf 'ghp_%s' "$(LC_ALL=C tr -dc A-Za-z0-9 </dev/urandom | head -c 36)"; }

newbranch() { git -C "$1" checkout -q -b "$2" main; }
commitfile() { # <repo> <file> <content> [msg]
  printf '%s\n' "$3" >"$1/$2" && git -C "$1" add "$2" && git -C "$1" commit -q -m "${4:-add $2}"
}

# ------------------------------------------------------------------ layer 1
L=1
mkrepo l1 || { echo "FAIL setup: could not build the temp repo"; exit 1; }
R="$WORK/l1"

printf '%s\n' "token = $(fake_token)" >"$R/cfg.txt"
git -C "$R" add cfg.txt
out="$(run_env git -C "$R" commit -q -m 'add cfg' 2>&1)"; expect "layer 1" "staged fake token blocks the commit" 1 $? "$out"
git -C "$R" reset -q; rm -f "$R/cfg.txt"

printf 'we worked with %s last year\n' "$TERM_TEXT" >"$R/notes.md"
git -C "$R" add notes.md
out="$(run_env git -C "$R" commit -q -m 'add notes' 2>&1)"; expect "layer 1" "blocked term in a file blocks the commit" 1 $? "$out"
git -C "$R" reset -q; rm -f "$R/notes.md"

printf 'fine\n' >"$R/ok.md"; git -C "$R" add ok.md
out="$(run_env git -C "$R" commit -q -m "work for $TERM_TEXT" 2>&1)"; expect "layer 1" "blocked term in the commit message blocks the commit" 1 $? "$out"
git -C "$R" reset -q; rm -f "$R/ok.md"

newbranch "$R" ok-branch
commitfile "$R" ok.md 'clean content'
out="$(run_env git -C "$R" push -q origin ok-branch 2>&1)"; expect "layer 1" "clean commit and push succeed" 0 $? "$out"

newbranch "$R" selftest-client-co
commitfile "$R" b.md 'clean content on a bad branch'
out="$(run_env git -C "$R" push -q origin selftest-client-co 2>&1)"; expect "layer 1" "blocked term in the branch name blocks the push" 1 $? "$out"

newbranch "$R" img-branch
printf '\211PNG\r\n\032\n\0\0\0\rIHDR' >"$R/pic.png"
git -C "$R" add pic.png && git -C "$R" commit -q -m 'add picture'
out="$(run_env git -C "$R" push -q origin img-branch 2>&1)"; expect "layer 1" "new image blocks the push when there is no tty" 1 $? "$out"

newbranch "$R" push-term
# commit with the hooks off in this temp repo only, as a bypassed commit would be
printf 'met %s\n' "$TERM_TEXT" >"$R/p.md"
git -C "$R" add p.md
git -C "$R" -c core.hooksPath=/dev/null commit -q -m 'add p'
out="$(run_env git -C "$R" push -q origin push-term 2>&1)"; expect "layer 1" "blocked term already committed is caught at push" 1 $? "$out"

# F1: a branch deleted on the server leaves a stale origin/<branch> here; pushing the same
# commit as a new branch must still be scanned (against the live remote, not local refs).
printf 'Unrelated Selftest Words\n' >"$WORK/other-terms.txt"
git -C "$R" checkout -q -b stale-src main
printf 'met %s\n' "$TERM_TEXT" >"$R/s.md"
git -C "$R" add s.md
TERMS="$WORK/other-terms.txt" run_env git -C "$R" commit -q -m 'add s' >/dev/null 2>&1
TERMS="$WORK/other-terms.txt" run_env git -C "$R" push -q origin stale-src >/dev/null 2>&1
git -C "$WORK/l1-origin.git" branch -q -D stale-src
git -C "$R" checkout -q -b stale-dst stale-src
out="$(run_env git -C "$R" push -q origin stale-dst 2>&1)"; expect "layer 1" "stale tracking ref does not hide a new-branch push" 1 $? "$out"

# The live tips come from the push URL: a fetch URL that already has the commit must not count.
git init -q --bare -b main "$WORK/l1-mirror.git"
TERMS="$WORK/other-terms.txt" run_env git -C "$R" push -q "$WORK/l1-mirror.git" stale-src >/dev/null 2>&1
git -C "$R" remote set-url origin "$WORK/l1-mirror.git"
git -C "$R" remote set-url --push origin "$WORK/l1-origin.git"
git -C "$R" checkout -q -b mirror-dst stale-src
out="$(run_env git -C "$R" push -q origin mirror-dst 2>&1)"; expect "layer 1" "a fetch URL that has the commit does not hide a push to the push URL" 1 $? "$out"
git -C "$R" config --unset remote.origin.pushurl
git -C "$R" remote set-url origin "$WORK/l1-origin.git"

# ------------------------------------------------------------------ layer 2
mkrepo l2 || { echo "FAIL setup: could not build the temp repo"; exit 1; }
R="$WORK/l2"
export CC=1

for ai in block fail; do
  newbranch "$R" "ai-$ai"; commitfile "$R" "$ai.md" "content $ai"
  out="$(AI=$ai run_env git -C "$R" push -q origin "ai-$ai" 2>&1)"
  expect "layer 2" "pre-push AI review with a $ai reviewer blocks the push" 1 $? "$out"
done
newbranch "$R" ai-pass; commitfile "$R" pass.md 'content pass'
out="$(AI=pass run_env git -C "$R" push -q origin ai-pass 2>&1)"; expect "layer 2" "pre-push AI review with a pass reviewer allows the push" 0 $? "$out"

# R22: the Claude hook leaves the AI review to pre-push, so its verdict cannot stop the hook.
git -C "$R" checkout -q ai-block
out="$(AI=block hook "$R" 'git push origin ai-block' 2>&1)"
expect "layer 2" "Claude hook on git push leaves the AI review to pre-push (exits 0)" 0 $? "$out"
newbranch "$R" hook-pass; commitfile "$R" hp.md 'hook pass content'
out="$(AI=pass hook "$R" 'git push origin hook-pass' 2>&1)"; expect "layer 2" "Claude hook on git push with a pass reviewer exits 0" 0 $? "$out"

# R22: a push over the 200 KB AI cap is reviewed in batches instead of being refused.
newbranch "$R" ai-big
for n in 1 2 3; do
  awk -v n="$n" 'BEGIN { for (i = 0; i < 2000; i++) printf "batch %s filler line number %d\n", n, i }' >"$R/big$n.md"
  git -C "$R" add "big$n.md" && git -C "$R" commit -q -m "big $n"
done
out="$(AI=pass run_env git -C "$R" push -q origin ai-big 2>&1)"
expect "layer 2" "pre-push AI review of a push over 200 KB runs in batches and passes" 0 $? "$out"
git -C "$R" checkout -q main

# ------------------------------------------------------------------ layer 3
CC=1
mkrepo l3 || { echo "FAIL setup: could not build the temp repo"; exit 1; }
R="$WORK/l3"
out="$(hook "$R" 'git push --no-verify' 2>&1)"; expect "layer 3" "git push --no-verify is denied" 2 $? "$out"
out="$(hook "$R" 'git -c core.hooksPath=/dev/null commit -m x' 2>&1)"; expect "layer 3" "git -c core.hooksPath=/dev/null commit is denied" 2 $? "$out"
out="$(hook "$R" 'git status' 2>&1)"; expect "layer 3" "plain git status is allowed" 0 $? "$out"

mkrepo l3b || { echo "FAIL setup: could not build the temp repo"; exit 1; }
R="$WORK/l3b"
rm -f "$R/.githooks/pre-push"
out="$(hook "$R" 'git commit -m x' 2>&1)"; expect "layer 3" "missing pre-push hook: git commit is blocked" 2 $? "$out"
out="$(hook "$R" 'git status' 2>&1)"; expect "layer 3" "missing pre-push hook: git status still allowed" 0 $? "$out"

# R21: an Edit or Write to a guard file asks a human; any other file passes silently.
EDIT_CMD="$(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const e=s.hooks.PreToolUse.find((x)=>x.matcher==="Edit|Write|MultiEdit|NotebookEdit"); process.stdout.write(e?e.hooks[0].command:"")' "$ROOT/.claude/settings.json")"
edit_hook() { # <repo> <tool> <file>
  local json
  json="$(node -e 'process.stdout.write(JSON.stringify({tool_name:process.argv[1],tool_input:{file_path:process.argv[2]},cwd:process.argv[3]}))' "$2" "$3" "$1")"
  (cd "$1" && printf '%s' "$json" | CLAUDE_PROJECT_DIR="$1" /bin/sh -c "$EDIT_CMD")
}
out="$(edit_hook "$R" Edit "$R/scripts/guard/check.mjs" 2>&1)"; rc=$?
case "$out" in *'"permissionDecision":"ask"'*) got=$rc ;; *) got="no-ask($rc)" ;; esac
expect "layer 3" "Edit of a guard file asks for approval" 0 "$got" "$out"
out="$(edit_hook "$R" Write "$R/src/page.astro" 2>&1)"; rc=$?
[ -z "$out" ] || rc="output($rc)"
expect "layer 3" "Write of an ordinary file passes silently" 0 "$rc" "$out"

# Node 22 unreachable: the hook must fail closed.
R="$WORK/l3"
out="$(cd "$R" && printf '%s' '{"tool_name":"Bash","tool_input":{"command":"git status"},"cwd":"x"}' \
  | env -u CLAUDECODE PATH=/usr/bin:/bin NVM_DIR=/nonexistent CLAUDE_PROJECT_DIR="$R" /bin/sh -c "$HOOK_CMD" 2>&1)"
expect "layer 3" "hook blocks when Node 22 is not reachable" 2 $? "$out"
unset CC

# ------------------------------------------------------------------ done
echo
if [ "$FAILS" -gt 0 ]; then echo "FAIL: $FAILS case(s) did not behave as expected"; exit 1; fi
echo "all guard layers behaved as expected"
