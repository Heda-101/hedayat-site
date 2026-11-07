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
  gitIn(dir, ['add', 'a.md']);
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

test('hook exits 2 when the AI review blocks, printing file:line and reason', () => {
  const dir = repo();
  commitFile(dir, 'b.md', 'clean words\n');
  const r = hook(bash('git push', dir), { ai: 'block' });
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /a\.md:3/);
  assert.match(r.out, /identifies a client/);
});

test('hook exits 2 when the AI review errors or returns garbage', () => {
  const dir = repo();
  commitFile(dir, 'b.md', 'clean words\n');
  for (const ai of ['fail', 'garbage']) {
    const r = hook(bash('git push origin feat/x', dir), { ai });
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /AI review/i);
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

test('hook masks blocked terms inside AI findings', () => {
  const dir = repo();
  commitFile(dir, 'b.md', 'clean words\n');
  const r = hook(bash('git push', dir), { ai: 'block', terms: termsFile('word:client\n') });
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /a\.md:3/);
  assert.doesNotMatch(r.out, /client/i);
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

test('hook exits 2 when its internal deadline is reached', () => {
  const dir = repo();
  commitFile(dir, 'b.md', 'clean words\n');
  const t0 = Date.now();
  const r = hook(bash('git push', dir), { ai: 'slow', env: { GUARD_HOOK_DEADLINE_MS: '1500' } });
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /deadline/i);
  assert.ok(Date.now() - t0 < 4500, 'hook should not wait for the slow reviewer');
});

test('hook deadline override can only shorten the 480 s default', () => {
  const dir = repo();
  commitFile(dir, 'b.md', 'clean words\n');
  const r = hook(bash('git push', dir), { env: { GUARD_HOOK_DEADLINE_MS: '99999999' } });
  assert.equal(r.status, 0, r.out);
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
