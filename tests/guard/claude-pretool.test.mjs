import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classifyCommand } from '../../scripts/guard/claude-pretool.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOOK = path.join(ROOT, 'scripts/guard/claude-pretool.mjs');
const FIX = path.join(ROOT, 'tests/guard/fixtures');
const fake = (n) => path.join(FIX, `fake-claude-${n}.sh`);
const B = { branch: 'feat/x' };

const dirs = [];
function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// ---------- classifier ----------

const denied = [
  // brief minimum
  'git push --no-verify', 'git commit -nm x', 'git -c core.hooksPath=/dev/null push',
  'git config core.hooksPath x', 'rm -rf .githooks', 'git push --force', 'git push origin main',
  'git push origin a:b', 'npm test && git push --all', 'GIT_DIR=/tmp/x git push',
  'GUARD_TERMS_FILE=/dev/null git commit -m x', 'export GUARD_TTY=/tmp/y; git push',
  // more of the deny list
  'git commit -n -m x', 'git commit -am x -n', 'git commit --no-verif -m x', 'git push --no-ver',
  'git push --git-dir=/tmp/x', 'git --git-dir=/tmp/x push', 'mv .githooks /tmp/h', 'chmod -x .githooks/pre-push',
  'git config --unset core.hookspath', 'git -c core.HOOKSPATH=x commit -m y', 'git config hooks.x y',
  'git -c include.path=/tmp/cfg push', 'git config alias.p "push --force"', 'git config remote.origin.mirror true',
  'git config push.default matching', 'git config --remove-section core', 'git config --edit',
  'echo hi > .githooks/pre-commit', 'cp /tmp/x .githooks/pre-push', 'sed -i "" s/a/b/ .git/config',
  'GIT_CONFIG_GLOBAL=/tmp/c git commit -m x', 'GIT_EXEC_PATH=/tmp git push', 'git --exec-path=/tmp push',
  'git push --mirror', 'git push --tags', 'git push --force-with-lease', 'git push -f',
  'git push upstream feat/x', 'git push origin feat/x other', 'git push origin +feat/x', 'git push origin HEAD',
  'git push --set-upstream origin feat/x', 'git push -q', 'git send-pack origin feat/x', 'git update-ref refs/remotes/origin/feat/x HEAD',
  'git commit-tree HEAD^{tree} -m x', 'git pu', 'git push origin feat/x; git push origin main',
  // nested shells
  'echo $(git push --force)', 'echo `git push`', 'bash -c "git push"', 'sh -c \'git push\'', 'eval git push',
  'echo feat/x | xargs git push origin', 'find . -exec git push \\;', 'zsh -c "git commit -m x"',
  'echo "git push origin main" | sh', 'python3 -c "import os; os.system(\'git push\')"', 'source <(echo git push)',
  // git through wrappers and global options
  'command git push --force', '/usr/bin/git push origin main', 'git -C /tmp/other push', 'git -C . commit -n -m x',
  'FOO=1 BAR=2 git push --force', 'env git push --mirror', 'env FOO=1 git push origin main', '\\git push --force',
  '"git" push --force', 'nohup git push --force', 'time git push --tags', 'sudo git push',
  'cd /tmp/other && git push', 'git push origin feat/x & git push origin main',
  'git --bogus-opt push', 'git "push" --force',
  // found during self-review
  "git commit -m x $'\\x2d\\x2dno-verify'", 'git ${X:-push} --force', 'x=$(echo push); git $x', 'git show $SHA',
  'git remote set-url origin /tmp/evil', 'git remote add gh https://example.invalid/r.git',
  'git fetch . HEAD:refs/remotes/origin/feat/x', 'git fetch origin +refs/heads/main:refs/remotes/origin/feat/x',
  'git pull /tmp/other feat/x', 'git commit -m "$(sh -c \'gi\'\'t push\')"', 'git -c core.hooks""Path=x push',
  'git config --local core.hooksPat\\h x', 'git -c core.sshCommand=x push', 'git submodule foreach git push --force',
  "git rebase -x 'git push --force' HEAD~1", 'pushd /tmp && git push', '(cd /tmp; git push)', 'f() { git push --force; }; f',
  'if true; then git push origin main; fi', 'true || git push --mirror', 'ln -sf /dev/null .githooks/pre-commit',
  'cat /dev/null > .githooks/pre-push', 'git checkout HEAD~5 -- .githooks', 'env -S "git push --force"',
  'timeout 5 git push origin main', 'exec git push --mirror', 'awk \'BEGIN{system("git push")}\'',
  'git push origin feat/x;git push --all', 'git push origin feat/x|git push --all', 'git push origin :feat/x',
  'git push origin refs/heads/feat/x', 'git push --dry-run',
  // fix round 1: globs and braces naming .githooks
  'rm -rf .githoo* && git status', 'rm -rf .gith*', 'mv .githook? /tmp/h', 'chmod -R -x .gith*', 'git rm -r .githoo*',
  'git checkout HEAD~5 -- .githoo*', 'git restore --source=HEAD~3 .githoo*', 'cp -r /tmp/x .githoo*', 'tee .githoo*/pre-push',
  'rm -rf ./.gIthooks', 'rm -rf .gi{t,x}hooks', 'rm -rf .[g]ithooks', 'rm -rf .* && git status', 'git add .githoo[k]s',
  // fix round 1: commands that execute their arguments still count as nested
  'flock /tmp/l git push --force', 'caffeinate git push --force', 'setsid git push', 'xcrun git push --force',
  // fix round 1: heredoc substitutions that are not plain data stay nested
  'git commit -m "$(cat <<EOF\n$(git push --force)\nEOF\n)"', 'git commit -m "$(cat <<EOF\n`git push`\nEOF\n)"',
  "git commit -m \"$(cat <<'EOF' /tmp/x\ngit\nEOF\n)\"", "git commit -m \"$(cat <<'EOF'\nmsg\nEOF\ngit push --force\n)\"",
  "git commit -m \"$(tac <<'EOF'\ngit\nEOF\n)\"", "git commit -m x && $(cat <<'EOF'\ngit push\nEOF\n)",
  // fix round 2 (CRITICAL 1): a data heredoc outside a message slot is not data
  "bash -c \"$(cat <<'EOF'\ngit push --no-verify --force origin main\nEOF\n)\"",
  "eval \"$(cat <<'EOF'\ngit push --force\nEOF\n)\"",
  "sh <<<\"$(cat <<'EOF'\ngit push --force\nEOF\n)\"",
  "echo \"$(cat <<'EOF'\ngit push --force\nEOF\n)\" | sh",
  "python3 -c \"$(cat <<'EOF'\nimport os; os.system('git push --force')\nEOF\n)\"",
  "\"$(cat <<'EOF'\ngit\nEOF\n)\" push --force",
  "xargs \"$(cat <<'EOF'\ngit\nEOF\n)\" push --force",
  "xargs \"$(cat <<'EOF'\ngit\nEOF\n)\" push --force < /dev/null",
  "x=\"$(cat <<'EOF'\ngit push --force\nEOF\n)\"; $x",
  "rm -rf \"$(cat <<'EOF'\n.githooks\nEOF\n)\"",
  "git log --grep \"$(cat <<'EOF'\ngit\nEOF\n)\"",
  "git commit -m \"$(cat <<'EOF'\nmsg git\nEOF\n)\" --no-verify",
  "git commit -m \"$(cat <<'EOF'\nmsg git\nEOF\n)\" -n",
  "git commit -m \"$(cat <<'EOF'\nx\nEOF\n)\"; git push --force",
  "gh pr list --search \"$(cat <<'EOF'\ngit\nEOF\n)\"",
  "cat <<'EOF' | sh\ngit push --force\nEOF",
  // fix round 2 self-review: an identical heredoc elsewhere must not borrow the message slot's exemption
  "gh pr create --body \"$(cat <<'EOF'\ngit push --no-verify\nEOF\n)\"; eval \"$(cat <<'EOF'\ngit push --no-verify\nEOF\n)\"",
  "gh pr create --body \"$(cat <<'EOF'\ngit push --no-verify\nEOF\n)\"; bash -c \"$(cat <<'EOF'\ngit push --no-verify\nEOF\n)\"",
  "gh pr create --body=$(cat <<'EOF'\ngit push\nEOF\n) && eval \"$(cat <<'EOF'\ngit push\nEOF\n)\"",
  "gh pr create --title t -b \"$(cat <<'EOF'\ngit push --force\nEOF\n)\" | sh",
  // fix round 2 (IMPORTANT 2): only allow-listed data commands may take a git argument
  'gtimeout 5 git push --force origin main', 'gtimeout 5 git commit -n -m x', 'entr git push --force',
  'uv run git push --force', 'npm exec -- git push --force', 'yarn exec git push --force',
  'direnv exec . git push --force', 'ssh localhost git push --force', 'op run -- git push --force',
  'pkexec git push --force', 'nsenter git push --force', 'sem git push --force', 'watchexec git push --force',
  'retry git push --force', 'sg staff git push --force', 'runuser -u me git push --force', 'echo x | gxargs git push --force',
  'gnohup git push --force', 'pipx run git push', 'nix-shell --run git', 'hyperfine "git push --force"',
  'npm test -- --grep git', 'sed "s/x/git push/e" f', 'sed -n "/git/w out" f', 'sed -f script.sed git',
  'X=1 make git', 'node -e 1 git',
  // fix round 2 (concern a): dot-led globs that can expand to .githooks
  'rm -rf .g*', 'rm -rf .??thooks', 'rm -rf .?ithooks', 'mv .g?thooks /tmp/h', 'rm -rf .*hooks', 'rm -rf .*',
  'rm -rf .[!.]*', 'chmod -x .*/pre-push', 'git rm -r .g*', 'git checkout HEAD -- .g*', 'rm -rf ./*/../.githoo*',
  'rm -rf {.githoo*,x}', 'rm -rf .g*;ls', 'ls; rm -rf .g*',
  // fix round 3 (A): non-leading dot globs
  'rm -rf scripts/../.g*', 'rm -rf /Users/x/hedayat-site/.g*', 'rm -rf ~/Documents/hedayat-site/.g*',
  // fix round 3 (B): stdin-fed execution and interpreter names as arguments
  'echo "git push --force origin main" | gtimeout 5 sh', 'echo "git push" | ssh localhost',
  "cat <<'EOF' | gtimeout 5 bash\ngit push --force origin main\nEOF", 'git log | gtimeout 5 bash',
  'gtimeout 5 sh script.sh && git status', 'gtimeout 5 bash < s.sh && git status', 'ssh localhost ls && git status',
  'printf "git push" | npx zx', "gtimeout 5 python3 <<<'git push'", 'echo git | retry -- bash',
];
for (const c of denied) {
  test(`deny: ${c}`, () => {
    const r = classifyCommand(c, B);
    assert.equal(r.action, 'deny', JSON.stringify(r));
    assert.ok(r.reason && r.reason.length > 0);
  });
}

const allowed = [
  'npm test', 'ls -la', 'git status', 'git diff --stat', 'git log --oneline -5', 'git add scripts/guard/x.mjs',
  'git commit -m "fix -n handling"', 'git commit -m "use --no-color"', 'git -C /tmp/other status', 'cat .githooks/pre-push',
  'ls .githooks', 'git diff .githooks', 'git config user.name', 'git config --get user.email', 'FOO=1 git status',
  'command git status', '/usr/bin/git log', 'git -c color.ui=never log', 'grep -r "git push" docs', 'cat .gitignore',
  'git fetch origin', 'git checkout -b feat/y', 'git branch --show-current', 'echo done && git status',
  'git remote -v', 'git fetch --prune origin', 'git commit -m "$(cat <<\'EOF\'\nfix: don\'t break\n\nbody\nEOF\n)"',
  'git commit -F /tmp/msg.txt', 'git status 2>&1 | tail -3',
  // fix round 1: a git argument to a non-executing command is data
  'cat file | grep git', 'grep -n "git" README.md', 'rg git src', 'ls ~/.config/git', 'echo git',
  'ls *.md && git status', 'cat docs/*.md | grep git', 'ls .github/*',
  // fix round 2: data-command allow-list and globs that cannot reach .githooks
  'grep -rn git . | head', 'sed -n 1,5p .gitignore', 'sed -n "/git/p" README.md', 'sed "s/git/GIT/g" a.md',
  'echo "use git" > notes.txt', 'printf "git\\n"', 'jq .git x.json', 'which git', 'man git', 'wc -l git.txt',
  'ls .git*', 'ls .gith*', 'ls .*', 'git diff .githoo*', 'git status .g*', 'ls *.md', 'rm -f .eslintcache*',
  'rm -rf node_modules/.cache/*', "git commit -F - <<'EOF'\nmsg git\nEOF",
  "gh pr create --title \"fix git hooks\" --body \"$(cat <<'EOF'\nAdds git hooks and --no-verify denial.\nEOF\n)\"",
  "gh issue edit 3 --body \"$(cat <<'EOF'\ngit hooks\nEOF\n)\"",
  "git commit -m \"$(cat <<'EOF'\nx\nEOF\n)\" -m \"$(cat <<'EOF'\ngit body\nEOF\n)\"",
  "git tag -a v1 -m \"$(cat <<'EOF'\ngit release\nEOF\n)\"",
  // fix round 3: pipes into data commands stay fine
  'git log --oneline | head -5', 'git status | grep modified', "cat <<'EOF' | grep git\ngit x\nEOF", 'git diff | wc -l',
  'npm test 2>&1 | tail -5 && git status',
  // fix round 1: the standard commit / PR heredoc form, even when the text mentions git or guard flags
  "git commit -m \"$(cat <<'EOF'\nfeat(guard): git hooks deny --no-verify and GUARD_TTY\n\nCo-Authored-By: X <x@example.invalid>\nEOF\n)\"",
  "gh pr create --title t --body \"$(cat <<'EOF'\nAdds git hooks (and core.hooksPath checks); don't skip them.\nEOF\n)\"",
  'git commit -m "$(cat <<EOF\nplain git message, no expansions\nEOF\n)"',
];
for (const c of allowed) {
  test(`allow: ${c}`, () => assert.deepEqual(classifyCommand(c, B), { action: 'allow' }));
}

test('push of current branch is a push', () => {
  const want = { action: 'push', remote: 'origin', branch: 'feat/x' };
  assert.deepEqual(classifyCommand('git push -u origin feat/x', B), want);
  assert.deepEqual(classifyCommand('git push origin feat/x', B), want);
  assert.deepEqual(classifyCommand('git push', B), want);
  assert.deepEqual(classifyCommand('npm test && git push', B), want);
  assert.deepEqual(classifyCommand('FOO=1 command /usr/bin/git push origin feat/x', B), want);
});

test('pushing main is denied, even bare', () => {
  assert.equal(classifyCommand('git push', { branch: 'main' }).action, 'deny');
  assert.equal(classifyCommand('git push origin main', { branch: 'main' }).action, 'deny');
});

test('detached HEAD denies any push', () => {
  for (const c of ['git push', 'git push origin feat/x', 'git push -u origin HEAD']) {
    const r = classifyCommand(c, { branch: null });
    assert.equal(r.action, 'deny');
    assert.match(r.reason, /detached/i);
  }
  assert.equal(classifyCommand('git status', { branch: null }).action, 'allow');
});

test('nested shell denial uses the agreed wording', () => {
  assert.match(classifyCommand('bash -c "git push"', B).reason, /nested shell around git is not allowed for agents/);
  assert.match(classifyCommand('echo $(git rev-parse HEAD)', B).reason, /nested shell around git/);
});

test('push deny uses the agreed wording', () => {
  assert.match(classifyCommand('git push --all', B).reason, /agents push only the current branch; ask Hedayat for anything else/);
});

test('deny reasons never echo the command', () => {
  const r = classifyCommand('GUARD_TERMS_FILE=/tmp/secret-name git commit -m x', B);
  assert.doesNotMatch(r.reason, /secret-name/);
});

// ---------- hook process ----------

function gitIn(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) assert.fail(`git ${args[0]} failed: ${r.stderr}`);
  return r.stdout;
}

function termsFile(content = 'Acme Corp\n') {
  const f = path.join(tmp('guard-terms-'), 'terms.txt');
  fs.writeFileSync(f, content);
  return f;
}

function repo({ branch = 'feat/x' } = {}) {
  const dir = tmp('guard-hookrepo-');
  const origin = tmp('guard-hookorigin-');
  gitIn(origin, ['init', '-q', '--bare', '-b', 'main']);
  gitIn(dir, ['init', '-q', '-b', 'main']);
  gitIn(dir, ['config', 'user.name', 'Test']);
  gitIn(dir, ['config', 'user.email', 'test@example.invalid']);
  gitIn(dir, ['config', 'commit.gpgsign', 'false']);
  gitIn(dir, ['remote', 'add', 'origin', origin]);
  fs.writeFileSync(path.join(dir, 'a.md'), 'base\n');
  // intact guard hooks (R18b): stub hooks, a stub check.mjs and core.hooksPath=.githooks
  fs.mkdirSync(path.join(dir, '.githooks'));
  for (const h of ['pre-commit', 'commit-msg', 'pre-push']) {
    fs.writeFileSync(path.join(dir, '.githooks', h), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  fs.mkdirSync(path.join(dir, 'scripts/guard'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts/guard/check.mjs'), '// stub\n');
  gitIn(dir, ['config', 'core.hooksPath', '.githooks']);
  gitIn(dir, ['add', 'a.md', '.githooks', 'scripts']);
  gitIn(dir, ['commit', '-q', '-m', 'base']);
  gitIn(dir, ['push', '-q', 'origin', 'main']);
  gitIn(dir, ['fetch', '-q', 'origin']);
  if (branch) gitIn(dir, ['checkout', '-q', '-b', branch]);
  return dir;
}

function commitFile(dir, name, content, msg = `add ${name}`) {
  fs.writeFileSync(path.join(dir, name), content);
  gitIn(dir, ['add', name]);
  gitIn(dir, ['commit', '-q', '-m', msg]);
}

function hook(input, { env = {}, ai = 'pass', terms = termsFile() } = {}) {
  const stdin = typeof input === 'string' ? input : JSON.stringify(input);
  const r = spawnSync(process.execPath, [HOOK], {
    input: stdin, encoding: 'utf8',
    env: { ...process.env, GUARD_AI_CMD: fake(ai), GUARD_TERMS_FILE: terms, ...env },
  });
  return { status: r.status, out: r.stdout + r.stderr };
}
const bash = (command, cwd) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd });

test('hook exits 0 for a clean push', () => {
  const dir = repo();
  commitFile(dir, 'b.md', 'clean words\n');
  const r = hook(bash('git push -u origin feat/x', dir));
  assert.equal(r.status, 0, r.out);
});

// R22: the AI review runs in the pre-push hook (R18a), not here, so the hook never calls the reviewer.
test('hook leaves the AI review to pre-push: any reviewer verdict passes the hook', () => {
  const dir = repo();
  commitFile(dir, 'b.md', 'clean words\n');
  for (const ai of ['block', 'fail', 'garbage', 'slow']) {
    const t0 = Date.now();
    const r = hook(bash('git push origin feat/x', dir), { ai });
    assert.equal(r.status, 0, `${ai}: ${r.out}`);
    assert.doesNotMatch(r.out, /AI review (passed|blocked|failed)/i, ai);
    assert.ok(Date.now() - t0 < 4000, `${ai}: hook must not wait for a reviewer`);
  }
});

test('hook exits 2 on a blocked term without printing it, and never calls the AI', () => {
  const dir = repo();
  commitFile(dir, 'b.md', 'x\nAcme Corp\n');
  const r = hook(bash('git push', dir), { ai: 'fail' });
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /blocked-term #1 at b\.md:2/);
  assert.doesNotMatch(r.out, /acme/i);
  assert.doesNotMatch(r.out, /AI review/i);
});

test('hook blocks any new image because agents cannot confirm', () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'p.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  gitIn(dir, ['add', 'p.png']);
  gitIn(dir, ['commit', '-q', '-m', 'img']);
  const yes = path.join(tmp('guard-tty-'), 'yes');
  fs.writeFileSync(yes, 'y\n');
  const r = hook(bash('git push', dir), { env: { GUARD_TTY: yes } });
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /p\.png/);
  assert.match(r.out, /Hedayat must push image changes himself/);
});

test('hook blocks a push when the terms file is missing', () => {
  const dir = repo();
  commitFile(dir, 'b.md', 'clean words\n');
  const r = hook(bash('git push', dir), { terms: path.join(tmp('guard-none-'), 'nope.txt') });
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /blocked-terms/);
});

test('hook scans a new branch with no remote tip (zero sha fallback)', () => {
  const dir = repo();
  commitFile(dir, 'b.md', 'Acme Corp\n');
  assert.equal(gitIn(dir, ['branch', '-r']).includes('origin/feat/x'), false);
  const r = hook(bash('git push -u origin feat/x', dir));
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /blocked-term #1 at b\.md:1/);
});

test('hook scans only commits after the remote tracking tip', () => {
  const dir = repo();
  commitFile(dir, 'b.md', 'Acme Corp\n');
  gitIn(dir, ['push', '-q', '-u', 'origin', 'feat/x']);
  commitFile(dir, 'c.md', 'clean words\n');
  const r = hook(bash('git push', dir));
  assert.equal(r.status, 0, r.out);
});

test('hook denies a push on a detached HEAD', () => {
  const dir = repo();
  gitIn(dir, ['checkout', '-q', '--detach']);
  const r = hook(bash('git push', dir));
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /detached/i);
});

test('hook denies when git would push somewhere other than origin/<branch>', () => {
  const dir = repo();
  commitFile(dir, 'b.md', 'clean words\n');
  gitIn(dir, ['config', 'push.default', 'matching']);
  let r = hook(bash('git push', dir));
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /push\.default/);
  gitIn(dir, ['config', '--unset', 'push.default']);
  gitIn(dir, ['config', 'push.default', 'upstream']);
  gitIn(dir, ['branch', '-u', 'origin/main']);
  r = hook(bash('git push', dir));
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /pushes to origin\/main/);
  gitIn(dir, ['config', '--unset', 'push.default']);
  gitIn(dir, ['branch', '--unset-upstream']);
  gitIn(dir, ['config', 'remote.origin.mirror', 'true']);
  r = hook(bash('git push', dir));
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /mirror/);
});

// A gitleaks stand-in that hangs, to exercise the hook's deadline.
function slowGitleaksPath() {
  const d = tmp('guard-slowbin-');
  fs.writeFileSync(path.join(d, 'gitleaks'), '#!/bin/sh\nsleep 5\n', { mode: 0o755 });
  return `${d}:${process.env.PATH}`;
}

test('hook exits 2 when its internal deadline is reached', () => {
  const dir = repo();
  commitFile(dir, 'b.md', 'clean words\n');
  const t0 = Date.now();
  const r = hook(bash('git push', dir), { env: { PATH: slowGitleaksPath(), GUARD_HOOK_DEADLINE_MS: '1500' } });
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /deadline/i);
  assert.ok(Date.now() - t0 < 4500, 'hook should not wait for the slow scan');
});

test('hook deadline override can only shorten the 480 s default', () => {
  const dir = repo();
  commitFile(dir, 'b.md', 'clean words\n');
  const r = hook(bash('git push', dir), { env: { GUARD_HOOK_DEADLINE_MS: '99999999' } });
  assert.equal(r.status, 0, r.out);
});

// ---------- R18b: integrity check before state-changing git ----------

const INTEGRITY = /guard hooks are missing or disabled; Hedayat must restore them \(bash scripts\/setup\.sh\)/;
const breakers = {
  'a hook file is removed': (dir) => fs.unlinkSync(path.join(dir, '.githooks/pre-push')),
  'core.hooksPath is unset': (dir) => gitIn(dir, ['config', '--unset', 'core.hooksPath']),
  'core.hooksPath points elsewhere': (dir) => gitIn(dir, ['config', 'core.hooksPath', '/dev/null']),
  'a hook is not executable': (dir) => fs.chmodSync(path.join(dir, '.githooks/pre-commit'), 0o644),
  'the hooks folder is gone': (dir) => fs.rmSync(path.join(dir, '.githooks'), { recursive: true }),
  'check.mjs is missing': (dir) => fs.unlinkSync(path.join(dir, 'scripts/guard/check.mjs')),
};
for (const [name, breakIt] of Object.entries(breakers)) {
  test(`R18b: when ${name}, state-changing git is denied and read-only git is allowed`, () => {
    const dir = repo();
    breakIt(dir);
    for (const c of ['git commit -m x', 'git push', 'git reset --hard', 'git checkout -b y', 'git tag v1',
      'git merge main', 'git rebase main', 'git cherry-pick HEAD', 'git switch main', 'git restore a.md',
      'git am x.patch', 'git apply x.patch', 'npm test && git commit -m x']) {
      const r = hook(bash(c, dir));
      assert.equal(r.status, 2, `${c}: ${r.out}`);
      assert.match(r.out, INTEGRITY, c);
    }
    for (const c of ['git status', 'git log --oneline', 'git diff', 'git show HEAD']) {
      assert.equal(hook(bash(c, dir)).status, 0, c);
    }
  });
}

test('R18b: intact hooks let state-changing git through', () => {
  const dir = repo();
  for (const c of ['git commit -m x', 'git checkout -b y', 'git tag v1']) {
    const r = hook(bash(c, dir));
    assert.equal(r.status, 0, `${c}: ${r.out}`);
  }
});

// A temp repo holding this repository's real guard files (not stubs) with the hooks set up the
// way setup.sh does, so tests never depend on how the checkout running them is configured.
function guardCopy() {
  const dir = tmp('guard-copy-');
  gitIn(dir, ['init', '-q', '-b', 'main']);
  gitIn(dir, ['config', 'user.name', 'Test']);
  gitIn(dir, ['config', 'user.email', 'test@example.invalid']);
  gitIn(dir, ['config', 'commit.gpgsign', 'false']);
  fs.cpSync(path.join(ROOT, '.githooks'), path.join(dir, '.githooks'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'scripts/guard'), path.join(dir, 'scripts/guard'), { recursive: true });
  fs.cpSync(path.join(ROOT, '.claude'), path.join(dir, '.claude'), { recursive: true });
  gitIn(dir, ['config', 'core.hooksPath', '.githooks']);
  fs.writeFileSync(path.join(dir, 'a.md'), 'base\n');
  gitIn(dir, ['add', 'a.md']);
  return dir;
}

test('R18b: this repository\'s real guard files pass the integrity check', () => {
  const dir = guardCopy();
  assert.equal(hook(bash('git commit --dry-run -m x', dir)).status, 0);
});

test('hook uses the real current branch', () => {
  const dir = repo({ branch: 'feat/real' });
  commitFile(dir, 'b.md', 'clean words\n');
  assert.equal(hook(bash('git push origin feat/x', dir)).status, 2);
  assert.equal(hook(bash('git push origin feat/real', dir)).status, 0);
});

test('hook denies with reason on stderr and exit 2', () => {
  const r = hook(bash('git push --no-verify', ROOT));
  assert.equal(r.status, 2);
  assert.match(r.out, /no-verify|hooks/i);
});

test('hook allows ordinary git commands with exit 0', () => {
  assert.equal(hook(bash('git status', ROOT)).status, 0);
});

test('R15: commands without git exit 0 even when the hook cannot work', () => {
  const nowhere = path.join(tmp('guard-gone-'), 'missing');
  assert.equal(hook(bash('npm test', nowhere)).status, 0);
  assert.equal(hook(bash('ls -la', ROOT), { env: { GUARD_AI_CMD: '/nonexistent' } }).status, 0);
});

test('R15: malformed or empty stdin exits 2 only when it mentions git', () => {
  assert.equal(hook('').status, 0);
  assert.equal(hook('not json at all').status, 0);
  assert.equal(hook('{"tool_input": {"command": "git push --forc').status, 2);
  assert.equal(hook('not json but git push').status, 2);
  assert.equal(hook(JSON.stringify({ tool_input: { command: 42 } })).status, 0);
  assert.equal(hook(JSON.stringify({ tool_input: {}, note: 'git' })).status, 2);
});

test('R14: an internal error on a push exits 2, not 1', () => {
  const nowhere = path.join(tmp('guard-gone-'), 'missing');
  const r = hook(bash('git push', nowhere));
  assert.equal(r.status, 2, r.out);
  const notRepo = tmp('guard-notrepo-');
  const r2 = hook(bash('git push', notRepo));
  assert.equal(r2.status, 2, r2.out);
});

// ---------- settings.json wiring ----------

function settingsCommand() {
  const s = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude/settings.json'), 'utf8'));
  const entry = s.hooks.PreToolUse.find((e) => e.matcher === 'Bash');
  assert.equal(entry.hooks[0].type, 'command');
  assert.equal(entry.hooks[0].timeout, 600);
  return entry.hooks[0].command;
}

function viaSettings(projectDir, input, env = {}) {
  const r = spawnSync('/bin/sh', ['-c', settingsCommand()], {
    input: JSON.stringify(input), encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, GUARD_TERMS_FILE: termsFile(), GUARD_AI_CMD: fake('pass'), ...env },
  });
  return { status: r.status, out: r.stdout + r.stderr };
}

test('settings command: deny is exit 2, ordinary command is exit 0', () => {
  assert.equal(viaSettings(ROOT, bash('git push --force', ROOT)).status, 2);
  assert.equal(viaSettings(ROOT, bash('git status', ROOT)).status, 0);
  assert.equal(viaSettings(ROOT, bash('npm test', ROOT)).status, 0);
});

test('settings command parses as bash and routes brace-spelled hook paths to Node', () => {
  const syn = spawnSync('bash', ['-n', '-c', settingsCommand()], { encoding: 'utf8' });
  assert.equal(syn.status, 0, syn.stderr);
  assert.equal(viaSettings(ROOT, bash('mv {.gi,}thooks /tmp/x', ROOT)).status, 2);
  assert.equal(viaSettings(ROOT, bash('mv .gi{t,x}hooks /tmp/x', ROOT)).status, 2);
  assert.equal(viaSettings(ROOT, bash('echo {a,b}', ROOT)).status, 0);
});

test('settings command: round-2 gaps are blocked end to end', () => {
  const blocked = [
    'rm -rf .g*', 'rm -rf .??thooks', 'mv .g?thooks /tmp/h', 'gtimeout 5 git commit -n -m x',
    "bash -c \"$(cat <<'EOF'\ngit push --no-verify --force origin main\nEOF\n)\"",
  ];
  for (const c of blocked) assert.equal(viaSettings(ROOT, bash(c, ROOT)).status, 2, c);
  const dir = guardCopy();
  assert.equal(viaSettings(dir, bash("git commit -m \"$(cat <<'EOF'\nfeat: git hooks\nEOF\n)\" --dry-run", dir)).status, 0);
});

test('settings command: dot-led globs reach Node even without Node 22 (fail closed), plain globs stay fast', () => {
  const env = { PATH: '/usr/bin:/bin', NVM_DIR: '/nonexistent', HOME: tmp('guard-home-') };
  assert.equal(viaSettings(ROOT, bash('rm -rf .g*', ROOT), env).status, 2);
  for (const c of ['rm -rf scripts/../.g*', 'rm -rf /Users/x/hedayat-site/.g*', 'rm -rf ~/Documents/hedayat-site/.g*']) {
    assert.equal(viaSettings(ROOT, bash(c, ROOT), env).status, 2, c);
    assert.equal(viaSettings(ROOT, bash(c, ROOT)).status, 2, c);
  }
  assert.equal(viaSettings(ROOT, bash('ls docs/*.md', ROOT), env).status, 0);
  assert.equal(viaSettings(ROOT, bash('ls *.md', ROOT), env).status, 0);
  assert.equal(viaSettings(ROOT, bash('ls -la', ROOT), env).status, 0);
});

test('settings command: Node 22 missing is exit 2 for git, exit 0 otherwise', () => {
  const home = tmp('guard-home-');
  const env = { PATH: '/usr/bin:/bin', NVM_DIR: '/nonexistent', HOME: home };
  const r = viaSettings(ROOT, bash('git push', ROOT), env);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /Node 22 required/);
  assert.equal(viaSettings(ROOT, bash('ls -la', ROOT), env).status, 0);
});

test('settings command: a Node crash becomes exit 2', () => {
  const proj = tmp('guard-proj-');
  fs.mkdirSync(path.join(proj, 'scripts/guard'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts/guard/node22.sh'), path.join(proj, 'scripts/guard/node22.sh'));
  fs.writeFileSync(path.join(proj, 'scripts/guard/claude-pretool.mjs'), 'throw new Error("boom");\n');
  const r = viaSettings(proj, bash('git status', proj));
  assert.equal(r.status, 2, r.out);
  fs.writeFileSync(path.join(proj, 'scripts/guard/claude-pretool.mjs'), 'process.exit(1);\n');
  assert.equal(viaSettings(proj, bash('git status', proj)).status, 2);
});
