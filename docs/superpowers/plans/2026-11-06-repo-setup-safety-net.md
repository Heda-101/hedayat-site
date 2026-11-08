# Milestone 0 · Repo Setup and Pre-Push Safety Net Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public GitHub repo where nothing leaves the laptop without passing three layers of checks (fixed rules, an AI confidentiality review, bypass prevention), proven by a self-test. The first two pull requests merge under that regime.

**Architecture:** Thin bash git hooks call one dependency-free Node script (`scripts/guard/`), which runs gitleaks and a blocked-terms scan over exactly what is being committed or pushed. A Claude Code PreToolUse hook re-runs the same checks on any agent `git push`, adds a headless `claude -p` confidentiality review of the diff, and denies bypass flags. A small GitHub Actions workflow repeats gitleaks, the term scan and the self-test on every PR.

**Tech Stack:** Node 22 (ESM `.mjs`, `node:test`, no npm dependencies; security tooling stays free of supply-chain risk), bash, gitleaks v8.19+, GitHub CLI, Claude Code CLI 2.1+.

**Spec:** `docs/superpowers/specs/2026-10-26-site-design.md` (§5 Constraints: Accounts, Pre-push safety net; §8 Milestone 0)

## Global Constraints

- Node ≥ 22 for every script. Machine default is v18.20.8; v22.23.3 is installed under nvm. Hooks must find Node 22 themselves or fail closed.
- No npm dependencies in `scripts/guard/`.
- Blocked-terms file: `~/.config/hedayat-site/blocked-terms.txt`, overridable with `GUARD_TERMS_FILE` (tests only). Never committed, never printed, never sent to the AI reviewer.
- Failure messages report file and line (and term number), **never the matched term**.
- Every check fails **closed**: missing tool, missing file, unparsable output or a timeout all block.
- Commits in this repo use the agent account's identity through **repo-local** git config only. Never touch global git config.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Confidentiality rule text lives once, in `CONTENT-GUIDELINES.md`, copied from spec §5. The AI reviewer reads it from there.
- Test fixtures must not contain literal secrets. Build fake tokens at runtime by concatenation, or our own gitleaks and GitHub push protection will (rightly) block them.

## Review Focus

1. **Node 22 missing from a hook's PATH** (GUI git clients and non-interactive shells don't load nvm). Expected: the hook tries `$NVM_DIR/nvm.sh`, then blocks with "Node 22 required", never skips. Test in Task 3.
2. **Terms file missing or empty.** Expected: block with "create ~/.config/hedayat-site/blocked-terms.txt with at least one term". An empty list means no protection. Test in Task 2.
3. **Spelling variants of a term** (case, hyphens, spaces, non-breaking space, full-width letters: "Sample-Tool", "SAMPLE TOOL"). Expected: caught. Test in Task 2.
4. **Unusual pushes:** a new branch (remote sha all zeros), a branch deletion (local sha all zeros), and a renamed file whose new path contains a term. Expected: new branch scans only commits not on any remote; deletion passes; renamed path is caught. Tests in Task 3.
5. **Big or binary diffs sent to the AI review.** Expected: binary files are listed by path only; a text diff over 200 000 bytes blocks with "split this push". Test in Task 5.

---

## File Structure

| Path | Responsibility |
|---|---|
| `README.md` | One-paragraph project intro + how to run setup and tests |
| `CONTENT-GUIDELINES.md` | Confidentiality rule (spec §5), read by humans and the AI reviewer |
| `.nvmrc` | `22` |
| `package.json` | `private`, `"type": "module"`, `engines.node >=22`, scripts `test:guard`, `guard:selftest` |
| `.githooks/pre-commit`, `commit-msg`, `pre-push` | Bash shims: find Node 22, call `check.mjs` |
| `scripts/guard/node22.sh` | Sourced by the shims: puts Node 22 on PATH or exits 1 |
| `scripts/guard/terms.mjs` | Load and match blocked terms |
| `scripts/guard/scope.mjs` | Turn git state into the list of things to scan |
| `scripts/guard/images.mjs` | Detect new image files; confirmation via `/dev/tty` |
| `scripts/guard/check.mjs` | CLI for the hooks: `staged`, `message <file>`, `push` |
| `scripts/guard/ai-review.mjs` | Build the review prompt, run `claude -p`, parse the verdict |
| `scripts/guard/claude-pretool.mjs` | Claude Code PreToolUse hook for Bash commands |
| `scripts/guard/selftest.sh` | End-to-end proof that each layer blocks |
| `scripts/setup.sh` | One-time local setup |
| `tests/guard/*.test.mjs` | Unit tests (`node --test`) |
| `.claude/settings.json` | Registers the PreToolUse hook |
| `.github/workflows/guard.yml` | gitleaks + term scan + unit tests + self-test on every PR |

---

### Task 0: Accounts, tools and domain (Hedayat, by hand)

Agents may not create accounts or type passwords, so Hedayat does these steps himself. The executor confirms each one is done before Task 1.

- [ ] **Step 1:** Create the agent GitHub account (machine account). Turn on 2FA and "Keep my email address private". Note its username and its `ID+username@users.noreply.github.com` address (Settings → Emails).
- [ ] **Step 2:** In a terminal on the laptop: `brew install gh gitleaks`, then `gh auth login` **as the agent account** (GitHub.com, HTTPS, scopes `repo` and `workflow`).
- [ ] **Step 3:** In a separate browser profile, signed in as **Hedayat's personal account**: create an empty **public** repo `hedayat-site` (no README, no license). Settings → Collaborators → add the agent account with **Write** role.
- [ ] **Step 4:** Create `~/.config/hedayat-site/blocked-terms.txt` with one term per line (client names, internal tool names, people, anything under NDA). Prefix a line with `word:` for whole-word matching of short terms. Lines starting `#` are comments. Do not paste the terms into chat.
- [ ] **Step 5:** Register `hedayattabesh.com` through Cloudflare Registrar.
- [ ] **Step 6:** Tell the executor: the agent username, its noreply email, and the personal account's username (the repo owner).

Verify: `gh auth status` shows the agent account; `gitleaks version` prints ≥ 8.19; `test -s ~/.config/hedayat-site/blocked-terms.txt && echo ok` prints `ok`.

---

### Task 1: Repo bootstrap

**Files:**
- Create: `README.md`, `CONTENT-GUIDELINES.md`, `.nvmrc`, `package.json`
- Modify: `.gitignore` (already exists: `.superpowers/`, `.DS_Store`, `node_modules/`, `dist/`, `.env*`)

**Interfaces:**
- Produces: `npm run test:guard` → `node --test tests/guard/`; `npm run guard:selftest` → `bash scripts/guard/selftest.sh`

- [ ] **Step 1:** Set repo-local identity: `git config user.name "<agent username>"` and `git config user.email "<agent noreply email>"`. Verify `git config --local user.email` prints the noreply address and `git config --global user.email` is unchanged.
- [ ] **Step 2:** Write `README.md` (what the site is, in two sentences, plus a "Setup" section pointing at `scripts/setup.sh`) and nothing else. Write `CONTENT-GUIDELINES.md` with the five bullets of spec §5 "Confidentiality rule", verbatim, under a heading `## Confidentiality rule`, followed by `## What the guard checks`, which lists the three layers in one line each.
- [ ] **Step 3:** Root commit on `main` containing `.gitignore` and `README.md` **only**: `git commit -m "chore: initialise repository"`. This root commit is the only commit that ever lands on main without a PR.
- [ ] **Step 4:** `git switch -c setup/guard`. Add `CONTENT-GUIDELINES.md`, `.nvmrc`, `package.json`. Commit `chore: add content guidelines and node config`.

Do not push anything in this task.

---

### Task 2: Blocked-terms matcher

**Files:**
- Create: `scripts/guard/terms.mjs`
- Test: `tests/guard/terms.test.mjs`

**Interfaces:**
- Produces:
  - `loadTerms(path: string): Term[]`, where `Term = { index: number, mode: 'loose' | 'word', norm: string }`. `index` is the 1-based line number in the file. Throws `GuardError` with code `TERMS_MISSING` or `TERMS_EMPTY`.
  - `normalize(s: string): string`: NFKC, lowercase, then strip everything that isn't `[a-z0-9]`.
  - `findTerms(text: string, terms: Term[]): { line: number, termIndex: number }[]`: one result per (line, term) pair. `loose` terms match `normalize(line).includes(term.norm)`. `word` terms match a case-insensitive `\b…\b` regex on the NFKC line.
  - `class GuardError extends Error { code: string }`, exported for every guard module.

- [ ] **Step 1: Write the failing tests**

```js
test('loose match survives case, hyphen, space, NBSP and full-width', () => {
  const t = [{ index: 1, mode: 'loose', norm: normalize('Sample Tool') }];
  for (const s of ['SampleTool', 'sample-tool', 'SAMPLE TOOL', 'Sample\u00A0Tool', 'Ｓａｍｐｌｅ Tool'])
    assert.deepEqual(findTerms(`uses ${s} here`, t), [{ line: 1, termIndex: 1 }]);
});
test('word mode does not match inside other words', () => {
  const t = [{ index: 2, mode: 'word', norm: 'qzx' }];
  assert.deepEqual(findTerms('a aqzxb', t), []);
  assert.deepEqual(findTerms('line one\nQZX rollout', t), [{ line: 2, termIndex: 2 }]);
});
test('loadTerms skips blanks and # comments, keeps file line numbers', () => {
  // file: "# c\n\nAcme Corp\nword:QZX\n"
  assert.deepEqual(loadTerms(f).map(t => [t.index, t.mode, t.norm]), [[3, 'loose', 'acmecorp'], [4, 'word', 'qzx']]);
});
test('missing file throws TERMS_MISSING; empty or comments-only throws TERMS_EMPTY', ...);
test('error messages never contain a term', ...); // throw on a line "word:" (empty term) → message mentions line 1 only
```

- [ ] **Step 2:** Run `node --test tests/guard/terms.test.mjs`. Expected: FAIL (module not found).
- [ ] **Step 3:** Implement `scripts/guard/terms.mjs` per the Interfaces block. A `word:` line with nothing after it throws `GuardError('TERMS_INVALID', 'blocked-terms line 1 is empty after "word:"')`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(guard): blocked-terms matcher`.

---

### Task 3: Scan scope, check CLI and git hooks

**Files:**
- Create: `scripts/guard/scope.mjs`, `scripts/guard/check.mjs`, `scripts/guard/node22.sh`, `.githooks/pre-commit`, `.githooks/commit-msg`, `.githooks/pre-push`, `scripts/setup.sh`
- Test: `tests/guard/scope.test.mjs`, `tests/guard/check.test.mjs`

**Interfaces:**
- Consumes: `loadTerms`, `findTerms`, `GuardError` (Task 2)
- Produces:
  - `parseAddedLines(unifiedDiff: string): { path: string, line: number, text: string }[]`: only `+` lines (not `+++`), with new-file line numbers from the hunk headers.
  - `parsePushRefs(stdin: string): { localRef, localSha, remoteRef, remoteSha }[]`
  - `pushRange(ref): { kind: 'delete' } | { kind: 'range', revs: string[] }`. Deletion when `localSha` is all zeros. Otherwise `revs` is `[remoteSha + '..' + localSha]`, or `[localSha, '--not', '--remotes']` when `remoteSha` is all zeros.
  - `collectStaged(): ScanItem[]` and `collectPush(refs): ScanItem[]`, where `ScanItem = { where: string, text: string }`, with `where` such as `src/a.md:12`, `commit 1a2b3c4 message`, `path src/new-name.md` or `branch refs/heads/x`. Renames contribute their new path.
  - `check.mjs` CLI: `node check.mjs staged | message <file> | push` (push reads hook stdin). Exit 0 = clean, 1 = blocked. Each finding prints as `blocked-term #<n> at <where>`. gitleaks runs first: `gitleaks git --staged --pre-commit --redact --no-banner` for `staged`, and `gitleaks git --log-opts="<revs joined>" --redact --no-banner` for each push range. A non-zero exit or missing binary blocks.

- [ ] **Step 1: Write the failing tests** (pure functions on fixture strings; `check.test.mjs` builds a throwaway repo in `os.tmpdir()` with `GUARD_TERMS_FILE` pointing at a temp terms file containing `Acme Corp`)

```js
test('parseAddedLines maps hunk line numbers', () => {
  const d = 'diff --git a/x.md b/x.md\n+++ b/x.md\n@@ -1,0 +5,2 @@\n+hello\n+world\n';
  assert.deepEqual(parseAddedLines(d), [{ path: 'x.md', line: 5, text: 'hello' }, { path: 'x.md', line: 6, text: 'world' }]);
});
test('pushRange: new branch, deletion, update', () => {
  const Z = '0'.repeat(40);
  assert.deepEqual(pushRange({ localSha: 'a'.repeat(40), remoteSha: Z }).revs, ['a'.repeat(40), '--not', '--remotes']);
  assert.equal(pushRange({ localSha: Z, remoteSha: 'b'.repeat(40) }).kind, 'delete');
});
test('staged: term in file blocks, output names file:line, not the term', ...);  // exit 1, stdout matches /blocked-term #1 at notes\.md:1/, not /acme/i
test('message: term in commit message blocks', ...);
test('push: term in a renamed path blocks', ...);
test('push: term in branch name blocks', ...);
test('clean staged change exits 0', ...);
test('pre-commit hook blocks when node 22 cannot be found', ...); // run .githooks/pre-commit with PATH=/usr/bin:/bin and NVM_DIR=/nonexistent → exit 1, stderr /Node 22 required/
```

- [ ] **Step 2:** Run `node --test tests/guard/`. Expected: FAIL.
- [ ] **Step 3:** Implement `scope.mjs` and `check.mjs` per the Interfaces block. Use `child_process.execFileSync('git', [...])`: `git diff --cached -U0 -M` for staged, `git log -p -U0 -M --format=...` over each range, and `git log --format=%H%x00%B%x00` for messages.
- [ ] **Step 4:** Implement `node22.sh`: if `node -v` is ≥ 22, return. Else, if `$NVM_DIR/nvm.sh` (default `~/.nvm`) exists, source it and run `nvm use 22 >/dev/null`, then re-check. Otherwise print `Node 22 required for the commit guard. Install it with nvm (nvm install 22).` and `exit 1`. Each `.githooks/*` file sources it and then runs `exec node scripts/guard/check.mjs <mode> "$@"` (pre-push passes stdin through).
- [ ] **Step 5:** Implement `scripts/setup.sh`: `git config core.hooksPath .githooks`, `chmod +x .githooks/*`, then verify gitleaks ≥ 8.19, Node 22 reachable via `node22.sh`, and the terms file non-empty. Print one line per check and exit 1 on any failure.
- [ ] **Step 6:** Run the tests. Expected: PASS. Run `bash scripts/setup.sh`. Expected: three `ok` lines.
- [ ] **Step 7:** Commit `feat(guard): scan scope, check CLI and git hooks`. This commit itself now passes through the new pre-commit hook.

---

### Task 4: New-image hold

**Files:**
- Create: `scripts/guard/images.mjs`
- Modify: `scripts/guard/check.mjs` (push mode only)
- Test: `tests/guard/images.test.mjs`

**Interfaces:**
- Produces:
  - `isImagePath(p: string): boolean` (case-insensitive extensions: png jpg jpeg gif webp avif svg heic bmp tiff ico)
  - `newImagesInPush(refs): string[]` (files with status `A` or `R` in the push ranges, from `git log --name-status`)
  - `confirmImages(paths: string[], tty = '/dev/tty'): boolean`: lists the paths and asks `Confirm these images contain no client or confidential content [y/N]`. Returns false if the tty can't be opened. **Agents have no tty, so their image pushes always block.** That is intended: Hedayat pushes those himself.

- [ ] **Step 1: Write the failing tests:** `isImagePath('a/B.PNG') === true`, `isImagePath('a.md') === false`; with a fake tty file containing `y\n` → true; containing `\n` → false; nonexistent tty path → false; `check.mjs push` on a range adding `x.png` with `GUARD_TTY=/nonexistent` → exit 1, stdout `/image needs confirmation: x\.png/`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. `check.mjs` reads `GUARD_TTY` (default `/dev/tty`) and calls `confirmImages` only after the term and secret scans pass.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(guard): hold pushes that add images`.

---

### Task 5: AI confidentiality review

**Files:**
- Create: `scripts/guard/ai-review.mjs`
- Test: `tests/guard/ai-review.test.mjs`, `tests/guard/fixtures/fake-claude-{pass,block,garbage,fail}.sh`

**Interfaces:**
- Consumes: `GuardError` (Task 2); `pushRange` (Task 3)
- Produces:
  - `MAX_DIFF_BYTES = 200_000`
  - `buildPrompt(guidelines: string, diff: string, binaryPaths: string[]): string`. Prompt shape: the guidelines, then "Review the diff below for anything that breaks these rules, including indirect identification of a client, employer-internal tool, or person. Reply with JSON only: {\"verdict\":\"pass\"|\"block\",\"findings\":[{\"file\":string,\"line\":number,\"reason\":string}]}", then binary paths as a list, then the diff in a fenced block.
  - `parseVerdict(claudeStdout: string): { verdict: 'pass' | 'block', findings: Finding[] }`. Input is `claude -p --output-format json` output: parse the envelope, take `.result`, strip a surrounding code fence if present, then `JSON.parse`. Throws `GuardError('AI_UNPARSABLE')` on anything else, including a missing or invalid `verdict`.
  - `reviewDiff(diff: string, binaryPaths: string[]): Promise<Verdict>`. Blocks with `AI_TOO_LARGE` when `Buffer.byteLength(diff) > MAX_DIFF_BYTES`. Spawns `process.env.GUARD_AI_CMD` if set (tests), else `claude -p --output-format json --model claude-sonnet-5-5 --tools ""`, with the prompt on stdin and a 120 s timeout. Non-zero exit or timeout → `GuardError('AI_FAILED')`. Never passes the blocked-terms list.

- [ ] **Step 1: Write the failing tests**

```js
test('parseVerdict reads the result field, with or without a code fence', () => {
  const env = r => JSON.stringify({ type: 'result', result: r });
  assert.equal(parseVerdict(env('{"verdict":"pass","findings":[]}')).verdict, 'pass');
  assert.equal(parseVerdict(env('```json\n{"verdict":"block","findings":[{"file":"a","line":1,"reason":"r"}]}\n```')).findings.length, 1);
});
test('parseVerdict throws AI_UNPARSABLE on prose or unknown verdict', ...);
test('buildPrompt includes guidelines, binary paths and diff', ...);
test('reviewDiff blocks diffs over 200000 bytes without calling the model', ...); // GUARD_AI_CMD = fake-claude-fail.sh; expect AI_TOO_LARGE
test('reviewDiff: fake pass → pass; fake block → block; garbage → AI_UNPARSABLE; exit 1 → AI_FAILED', ...);
```

- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Before relying on it, confirm the CLI flags with `claude --help`; `--tools`, `--output-format` and `--model` exist in 2.1.310.
- [ ] **Step 4:** Run. Expected: PASS. Then one live run: `node -e` calling `reviewDiff` on a harmless two-line diff. Expected: `verdict: 'pass'`.
- [ ] **Step 5:** Commit `feat(guard): AI confidentiality review`.

---

### Task 6: Claude Code PreToolUse hook

**Files:**
- Create: `scripts/guard/claude-pretool.mjs`, `.claude/settings.json`
- Test: `tests/guard/claude-pretool.test.mjs`

**Interfaces:**
- Consumes: `collectPush`, `pushRange` (Task 3); `newImagesInPush` (Task 4); `reviewDiff` (Task 5); the scan functions behind `check.mjs` (export `runPushChecks(refs): { ok: boolean, lines: string[] }` from `check.mjs` in this task)
- Produces:
  - `classifyCommand(cmd: string): { action: 'allow' } | { action: 'deny', reason: string } | { action: 'push', remote: string, branch: string }`
  - Deny when the command contains any of: `--no-verify`; `git commit` with `-n` as a short flag (alone or bundled, e.g. `-nm`); `core.hooksPath`; `git config` touching `hooks`; `rm`, `mv` or `chmod` of anything under `.githooks`; `GIT_DIR=` or `--git-dir`; any `GUARD_` variable (e.g. pointing `GUARD_TERMS_FILE` at an empty file or `GUARD_TTY` at a fake "y").
  - A `git push` is allowed only as `git push`, `git push origin <current-branch>` or `git push -u origin <current-branch>`, where `<current-branch>` ≠ `main`. Anything else (`--all`, `--mirror`, `--tags`, `--force*`, refspecs with `:`, more than one ref, other remotes) → deny "agents push only the current branch; ask Hedayat for anything else".
  - Commands joined with `&&`, `;`, `|` or `||` are split, and each part is classified. Any deny wins.
  - Hook I/O: reads Claude Code hook JSON on stdin, uses `tool_input.command`. On deny, prints the reason to stderr and exits 2. On `push`, builds refs for the current branch against `origin`, runs `runPushChecks`, blocks on any new image (agents can't confirm), then runs `reviewDiff`. Any finding or error → exit 2 with the reason lines. Otherwise exit 0.
- `.claude/settings.json`: `{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"bash -c 'source \"$CLAUDE_PROJECT_DIR\"/scripts/guard/node22.sh && node \"$CLAUDE_PROJECT_DIR\"/scripts/guard/claude-pretool.mjs'","timeout":180}]}]}}`

- [ ] **Step 1: Write the failing tests**

```js
const denied = ['git push --no-verify', 'git commit -nm x', 'git -c core.hooksPath=/dev/null push',
  'git config core.hooksPath x', 'rm -rf .githooks', 'git push --force', 'git push origin main',
  'git push origin a:b', 'npm test && git push --all', 'GIT_DIR=/tmp/x git push',
  'GUARD_TERMS_FILE=/dev/null git commit -m x', 'export GUARD_TTY=/tmp/y; git push'];
for (const c of denied) test(`deny: ${c}`, () => assert.equal(classifyCommand(c, { branch: 'feat/x' }).action, 'deny'));
test('allow ordinary commands', () => assert.equal(classifyCommand('npm test', { branch: 'feat/x' }).action, 'allow'));
test('push of current branch is a push', () =>
  assert.deepEqual(classifyCommand('git push -u origin feat/x', { branch: 'feat/x' }), { action: 'push', remote: 'origin', branch: 'feat/x' }));
test('hook exits 2 when the AI review blocks', ...);   // temp repo + bare origin, GUARD_AI_CMD=fake-claude-block.sh
test('hook exits 2 when the AI review errors', ...);   // fake-claude-fail.sh
test('hook exits 0 for a clean push', ...);             // fake-claude-pass.sh
```

`classifyCommand` takes a second argument, `{ branch: string }`, so tests don't depend on git. The hook passes the real current branch.

- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement `classifyCommand`, the hook entry point and `runPushChecks`. Then refactor `check.mjs push` to call `runPushChecks`.
- [ ] **Step 4:** Run all guard tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(guard): Claude Code push hook and bypass denial`.

---

### Task 7: Self-test and CI workflow

**Files:**
- Create: `scripts/guard/selftest.sh`, `.github/workflows/guard.yml`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `npm run guard:selftest` prints one `PASS <layer>: <case>` line per case and exits 0 only if every case behaves as expected. This output is the evidence the spec asks for ("a test that proves each layer blocks"), and it becomes a Test-chapter item later.
  - `check.mjs ci <baseSha> <headSha>`: the blocked-terms scan over file contents, paths and commit messages in `base..head`. No gitleaks (CI runs it separately) and no image hold (CI has no tty, and Hedayat already confirmed images at push time). Exit 0 or 1, same output format.

- [ ] **Step 1:** Write `selftest.sh`. In a fresh temp repo with this repo's `.githooks` and a bare `origin`, with `GUARD_TERMS_FILE` set to a temp file containing `Selftest Client Co`, it asserts:
  - **Layer 1, blocks:** a staged fake token blocks the commit (the token is built at runtime, e.g. `printf 'ghp_%s' "$(LC_ALL=C tr -dc A-Za-z0-9 </dev/urandom | head -c 36)"`); a term in a file blocks the commit; a term in the commit message blocks; a term in the branch name blocks the push; a new image blocks the push with `GUARD_TTY=/nonexistent`.
  - **Layer 1, allows:** a clean commit and push succeed.
  - **Layer 2:** `claude-pretool.mjs`, fed hook JSON for `git push`, exits 2 with `fake-claude-block.sh` and with `fake-claude-fail.sh`, and exits 0 with `fake-claude-pass.sh`.
  - **Layer 3:** hook JSON for `git push --no-verify` and for `git -c core.hooksPath=/dev/null commit -m x` both exit 2.
  - Also: the hook blocks when Node 22 isn't reachable.
- [ ] **Step 2:** Run `npm run guard:selftest`. Expected: every line `PASS`, exit 0.
- [ ] **Step 3:** Write `guard.yml`. Trigger: `pull_request` and `push` to `main`. Job on `ubuntu-latest`:
  - `actions/checkout` with `fetch-depth: 0`, then `actions/setup-node` with `node-version-file: .nvmrc`, both pinned to full commit SHAs looked up at implementation time.
  - Install gitleaks from its official release tarball (pinned version + checksum), then `gitleaks git --redact --no-banner`.
  - `npm run test:guard`, then `npm run guard:selftest`.
  - Term scan: write the Actions secret `BLOCKED_TERMS` to a temp file, point `GUARD_TERMS_FILE` at it, and run `node scripts/guard/check.mjs ci "$BASE" "$HEAD"`, with the PR base and head SHAs (on `push` to main: `github.event.before` and `github.sha`). If the secret is unset, the step fails with "BLOCKED_TERMS secret not set". Add a unit test for `ci` mode to `check.test.mjs` (a term in `base..head` exits 1; a clean range exits 0).
- [ ] **Step 4:** Commit `ci: guard workflow` (the workflow is validated by its first run in Task 8).

---

### Task 8: Publish under the guard (agent + Hedayat)

- [ ] **Step 1 (agent):** `git remote add origin https://github.com/<owner>/hedayat-site.git`. Accept the collaborator invite: `gh api user/repository_invitations` → `gh api -X PATCH user/repository_invitations/<id>`.
- [ ] **Step 2 (Hedayat, in his own terminal):** `git push -u origin main` (root commit only). The Claude hook denies agents pushing `main` by design, so this one-time bootstrap push is his. Expected: the git pre-push hook runs and passes.
- [ ] **Step 3 (Hedayat, browser profile as owner):**
  - Settings → Code security: enable **Secret scanning** and **Push protection**.
  - Settings → Rules → new branch ruleset on `main`: require a pull request with **1 approval**; dismiss stale approvals; require conversation resolution; require status check `guard`; block force pushes; restrict deletions; no bypass list.
  - Settings → Secrets and variables → Actions: add `BLOCKED_TERMS` (the same content as the local file).
- [ ] **Step 4 (agent):** `git push -u origin setup/guard`. Expected: the Claude hook runs layers 1 and 2 and passes. Open the PR: `gh pr create --base main --title "Commit and push safety net" --body` (summary + the self-test output + attribution line). Expected: the `guard` check goes green.
- [ ] **Step 5 (Hedayat):** review and approve the PR in the browser, then squash-merge. Expected: the merge button is disabled until approval and green checks. Confirm the agent account cannot merge it alone.
- [ ] **Step 6 (agent):** `git switch main && git pull`, then `git switch -c docs/design-spec`. Add `docs/superpowers/specs/2026-10-26-site-design.md`, `docs/design/mockups/early-mockups.html` and this plan. Commit `docs: phase 1 design, early mockups and milestone 0 plan`, push, open the PR. Expected: the guard passes, and the AI review raises no findings (the spec was already cleaned of internal names). Hedayat approves and merges.

Milestone 0 is done when both PRs are merged, the ruleset is active, and `npm run guard:selftest` passes on main.
