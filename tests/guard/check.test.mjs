import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHECK = path.join(ROOT, 'scripts/guard/check.mjs');
const HOOKS = path.join(ROOT, '.githooks');
const Z = '0'.repeat(40);

const dirs = [];
function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function git(cwd, args, opts = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...opts.env }, input: opts.input });
  if (!opts.allowFail && r.status !== 0) assert.fail(`git ${args[0]} failed: ${r.stderr}`);
  return r;
}

function termsFile(content = 'Acme Corp\n') {
  const f = path.join(tmp('guard-terms-'), 'terms.txt');
  fs.writeFileSync(f, content);
  return f;
}

function mkRepo() {
  const dir = tmp('guard-repo-');
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'user.email', 'test@example.invalid']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}

function mkRepoWithOrigin() {
  const dir = mkRepo();
  const origin = tmp('guard-origin-');
  git(origin, ['init', '-q', '--bare', '-b', 'main']);
  git(dir, ['remote', 'add', 'origin', origin]);
  fs.writeFileSync(path.join(dir, 'a.md'), 'base\n');
  git(dir, ['add', 'a.md']);
  git(dir, ['commit', '-q', '-m', 'base']);
  git(dir, ['push', '-q', 'origin', 'main']);
  return dir;
}

function check(cwd, args, { terms = termsFile(), input = '', env = {} } = {}) {
  const r = spawnSync(process.execPath, [CHECK, ...args], {
    cwd, input, encoding: 'utf8',
    env: { ...process.env, GUARD_TERMS_FILE: terms, ...env },
  });
  return { status: r.status, out: r.stdout + r.stderr };
}

const rev = (dir, r) => git(dir, ['rev-parse', r]).stdout.trim();
const pushLine = (dir, ref, remoteSha = Z) => `refs/heads/${ref} ${rev(dir, ref)} refs/heads/${ref} ${remoteSha}\n`;

test('staged: term in file blocks, output names file:line, not the term', () => {
  const dir = mkRepo();
  fs.writeFileSync(path.join(dir, 'notes.md'), 'we worked with Acme Corp last year\n');
  git(dir, ['add', 'notes.md']);
  const r = check(dir, ['staged']);
  assert.equal(r.status, 1);
  assert.match(r.out, /blocked-term #1 at notes\.md:1/);
  assert.doesNotMatch(r.out, /acme/i);
});

test('staged: term in a file name blocks without echoing the name', () => {
  const dir = mkRepo();
  fs.writeFileSync(path.join(dir, 'acme-corp.md'), 'clean\n');
  git(dir, ['add', 'acme-corp.md']);
  const r = check(dir, ['staged']);
  assert.equal(r.status, 1);
  assert.match(r.out, /blocked-term #1/);
  assert.doesNotMatch(r.out, /acme/i);
});

test('clean staged change exits 0', () => {
  const dir = mkRepo();
  fs.writeFileSync(path.join(dir, 'ok.md'), 'nothing to see\n');
  git(dir, ['add', 'ok.md']);
  const r = check(dir, ['staged']);
  assert.equal(r.status, 0, r.out);
});

test('message: term in commit message blocks', () => {
  const dir = mkRepo();
  const f = path.join(dir, 'MSG');
  fs.writeFileSync(f, 'fix things for ACME-corp\n\n# comment\n');
  const r = check(dir, ['message', f]);
  assert.equal(r.status, 1);
  assert.match(r.out, /blocked-term #1 at commit message/);
  assert.doesNotMatch(r.out, /acme/i);
});

test('message: clean message passes', () => {
  const dir = mkRepo();
  const f = path.join(dir, 'MSG');
  fs.writeFileSync(f, 'fix things\n\n# a harmless comment\n');
  assert.equal(check(dir, ['message', f]).status, 0);
});

test('push: term in a renamed path blocks', () => {
  const dir = mkRepoWithOrigin();
  const base = rev(dir, 'main');
  git(dir, ['mv', 'a.md', 'acme-corp.md']);
  git(dir, ['commit', '-q', '-m', 'rename']);
  const r = check(dir, ['push'], { input: pushLine(dir, 'main', base) });
  assert.equal(r.status, 1);
  assert.match(r.out, /blocked-term #1 at path/);
  assert.doesNotMatch(r.out, /acme/i);
});

test('push: term in added content and in a commit message block', () => {
  const dir = mkRepoWithOrigin();
  const base = rev(dir, 'main');
  fs.writeFileSync(path.join(dir, 'b.md'), 'x\nAcme Corp\n');
  git(dir, ['add', 'b.md']);
  git(dir, ['commit', '-q', '-m', 'add b']);
  let r = check(dir, ['push'], { input: pushLine(dir, 'main', base) });
  assert.equal(r.status, 1);
  assert.match(r.out, /blocked-term #1 at b\.md:2/);

  const dir2 = mkRepoWithOrigin();
  const base2 = rev(dir2, 'main');
  fs.writeFileSync(path.join(dir2, 'c.md'), 'fine\n');
  git(dir2, ['add', 'c.md']);
  git(dir2, ['commit', '-q', '-m', 'work for acme corp']);
  r = check(dir2, ['push'], { input: pushLine(dir2, 'main', base2) });
  assert.equal(r.status, 1);
  assert.match(r.out, /blocked-term #1 at commit [0-9a-f]+ message/);
  assert.doesNotMatch(r.out, /acme/i);
});

test('push: term in branch name blocks', () => {
  const dir = mkRepoWithOrigin();
  git(dir, ['checkout', '-q', '-b', 'feat/acme-corp']);
  const r = check(dir, ['push'], { input: pushLine(dir, 'feat/acme-corp') });
  assert.equal(r.status, 1);
  assert.match(r.out, /blocked-term #1 at branch/);
  assert.doesNotMatch(r.out, /acme/i);
});

test('push: new branch (zero remote sha) scans only commits not on any remote', () => {
  const dir = mkRepoWithOrigin();
  // a commit with the term that IS already on the remote must not be rescanned
  fs.writeFileSync(path.join(dir, 'old.md'), 'Acme Corp\n');
  git(dir, ['add', 'old.md']);
  git(dir, ['commit', '-q', '-m', 'old']);
  git(dir, ['push', '-q', 'origin', 'main']);
  git(dir, ['checkout', '-q', '-b', 'feature']);
  fs.writeFileSync(path.join(dir, 'new.md'), 'clean\n');
  git(dir, ['add', 'new.md']);
  git(dir, ['commit', '-q', '-m', 'new']);
  const clean = check(dir, ['push'], { input: pushLine(dir, 'feature') });
  assert.equal(clean.status, 0, clean.out);

  fs.writeFileSync(path.join(dir, 'bad.md'), 'Acme Corp\n');
  git(dir, ['add', 'bad.md']);
  git(dir, ['commit', '-q', '-m', 'bad']);
  const bad = check(dir, ['push'], { input: pushLine(dir, 'feature') });
  assert.equal(bad.status, 1);
  assert.match(bad.out, /blocked-term #1 at bad\.md:1/);
});

test('push: branch deletion passes without scanning', () => {
  const dir = mkRepoWithOrigin();
  const sha = rev(dir, 'main');
  const r = check(dir, ['push'], { input: `(delete) ${Z} refs/heads/acme-corp ${sha}\n` });
  assert.equal(r.status, 0, r.out);
});

test('push: empty stdin passes', () => {
  const dir = mkRepoWithOrigin();
  assert.equal(check(dir, ['push'], { input: '' }).status, 0);
});

test('missing gitleaks binary blocks (fail closed)', () => {
  const dir = mkRepo();
  fs.writeFileSync(path.join(dir, 'ok.md'), 'clean\n');
  git(dir, ['add', 'ok.md']);
  const empty = tmp('guard-nopath-');
  const r = check(dir, ['staged'], { env: { PATH: empty } });
  assert.equal(r.status, 1);
  assert.match(r.out, /gitleaks/i);
});

test('gitleaks finding blocks and does not print the secret', () => {
  const dir = mkRepo();
  const secret = 'AKIA' + 'IOSFODNN7' + 'EXAMPLX';
  fs.writeFileSync(path.join(dir, 'k.env'), `aws_access_key_id = ${secret}\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n`);
  git(dir, ['add', 'k.env']);
  const r = check(dir, ['staged']);
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.out, new RegExp(secret));
});

test('terms file missing or empty gives the setup hint and exit 1', () => {
  const dir = mkRepo();
  const missing = check(dir, ['staged'], { terms: path.join(tmp('guard-none-'), 'nope.txt') });
  assert.equal(missing.status, 1);
  assert.match(missing.out, /create ~\/\.config\/hedayat-site\/blocked-terms\.txt with at least one term/);
  const empty = check(dir, ['staged'], { terms: termsFile('# nothing\n') });
  assert.equal(empty.status, 1);
  assert.match(empty.out, /create ~\/\.config\/hedayat-site\/blocked-terms\.txt/);
});

test('invalid terms file exits 1 without echoing its contents', () => {
  const dir = mkRepo();
  const r = check(dir, ['staged'], { terms: termsFile('word:Acme Corp\n') });
  assert.equal(r.status, 1);
  assert.match(r.out, /line 1/);
  assert.doesNotMatch(r.out, /acme/i);
});

test('unknown mode exits 1', () => {
  assert.equal(check(mkRepo(), ['bogus']).status, 1);
});

test('pre-commit hook blocks when node 22 cannot be found', () => {
  const dir = mkRepo();
  const r = spawnSync(path.join(HOOKS, 'pre-commit'), [], {
    cwd: dir, encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', NVM_DIR: '/nonexistent', HOME: dir },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Node 22 required/);
});

function hooked(dir) {
  git(dir, ['config', 'core.hooksPath', HOOKS]);
  return { GUARD_TERMS_FILE: termsFile() };
}

test('wiring: real git commit runs pre-commit and commit-msg hooks', () => {
  const dir = mkRepo();
  const env = hooked(dir);
  fs.writeFileSync(path.join(dir, 'n.md'), 'Acme Corp\n');
  git(dir, ['add', 'n.md']);
  let r = git(dir, ['commit', '-q', '-m', 'clean message'], { env, allowFail: true });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /blocked-term #1 at n\.md:1/);

  fs.writeFileSync(path.join(dir, 'n.md'), 'clean\n');
  git(dir, ['add', 'n.md']);
  r = git(dir, ['commit', '-q', '-m', 'for Acme Corp'], { env, allowFail: true });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /blocked-term #1 at commit message/);

  r = git(dir, ['commit', '-q', '-m', 'clean message'], { env, allowFail: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('wiring: real git push runs the pre-push hook', () => {
  const dir = mkRepoWithOrigin();
  const env = hooked(dir);
  git(dir, ['checkout', '-q', '-b', 'feature']);
  fs.writeFileSync(path.join(dir, 'p.md'), 'Acme Corp\n');
  git(dir, ['add', 'p.md']);
  git(dir, ['commit', '-q', '-m', 'p'], { env: { GUARD_TERMS_FILE: termsFile('Unrelated Thing\n') } });
  let r = git(dir, ['push', '-q', 'origin', 'feature'], { env, allowFail: true });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /blocked-term #1 at p\.md:1/);
  assert.equal(git(dir, ['ls-remote', '--heads', 'origin', 'feature']).stdout.trim(), '');

  git(dir, ['reset', '-q', '--hard', 'main']);
  fs.writeFileSync(path.join(dir, 'q.md'), 'clean\n');
  git(dir, ['add', 'q.md']);
  git(dir, ['commit', '-q', '-m', 'q'], { env });
  r = git(dir, ['push', '-q', 'origin', 'feature'], { env, allowFail: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

// ---- fix round 1: silent-pass gaps ----
const FAKE_KEY = 'AKIA' + 'IOSFODNN7' + 'EXAMPLX';

test('push: unknown remote sha still runs gitleaks on the fallback range', () => {
  const dir = mkRepoWithOrigin();
  fs.writeFileSync(path.join(dir, 'k.env'),
    `aws_access_key_id = ${FAKE_KEY}\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n`);
  git(dir, ['add', 'k.env']);
  git(dir, ['commit', '-q', '-m', 'keys']);
  const r = check(dir, ['push'], { input: pushLine(dir, 'main', 'f'.repeat(40)) });
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.out, new RegExp(FAKE_KEY));
});

test('staged: file with a NUL byte is still term-scanned', () => {
  const dir = mkRepo();
  fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from('head\0\nAcme Corp\n'));
  git(dir, ['add', 'bin.dat']);
  const r = check(dir, ['staged']);
  assert.equal(r.status, 1);
  assert.match(r.out, /blocked-term #1 at bin\.dat:2/);
});

test('staged and push: a -diff gitattribute does not hide content', () => {
  const dir = mkRepoWithOrigin();
  const base = rev(dir, 'main');
  fs.writeFileSync(path.join(dir, '.gitattributes'), '*.md -diff\n');
  fs.writeFileSync(path.join(dir, 'h.md'), 'Acme Corp\n');
  git(dir, ['add', 'h.md']);
  assert.equal(check(dir, ['staged']).status, 1);
  git(dir, ['add', '.gitattributes']);
  git(dir, ['commit', '-q', '-m', 'h']);
  const r = check(dir, ['push'], { input: pushLine(dir, 'main', base) });
  assert.equal(r.status, 1);
  assert.match(r.out, /blocked-term #1 at h\.md:1/);
});

test('user git color config does not hide content', () => {
  const dir = mkRepo();
  git(dir, ['config', 'color.ui', 'always']);
  git(dir, ['config', 'color.diff', 'always']);
  fs.writeFileSync(path.join(dir, 'c.md'), 'Acme Corp\n');
  git(dir, ['add', 'c.md']);
  assert.equal(check(dir, ['staged']).status, 1);
  git(dir, ['commit', '-q', '-m', 'c']);
  const r = check(dir, ['push'], { input: pushLine(dir, 'main') });
  assert.equal(r.status, 1);
  assert.match(r.out, /blocked-term #1 at c\.md:1/);
});

test('log.showRoot=false does not hide the root commit', () => {
  const dir = mkRepo();
  git(dir, ['config', 'log.showRoot', 'false']);
  fs.writeFileSync(path.join(dir, 'r.md'), 'Acme Corp\n');
  git(dir, ['add', 'r.md']);
  git(dir, ['commit', '-q', '-m', 'root']);
  const r = check(dir, ['push'], { input: pushLine(dir, 'main') });
  assert.equal(r.status, 1);
  assert.match(r.out, /blocked-term #1 at r\.md:1/);
});

test('message: a # line is scanned (git keeps it with -m / verbatim)', () => {
  const dir = mkRepo();
  const f = path.join(dir, 'MSG');
  fs.writeFileSync(f, 'fix\n\n#Acme Corp\n');
  const r = check(dir, ['message', f]);
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.out, /acme/i);
});

test('push: annotated tag message and commit author are scanned', () => {
  const dir = mkRepoWithOrigin();
  git(dir, ['tag', '-a', 'v1', '-m', 'release for Acme Corp']);
  const tagSha = git(dir, ['rev-parse', 'v1']).stdout.trim();
  let r = check(dir, ['push'], { input: `refs/tags/v1 ${tagSha} refs/tags/v1 ${Z}\n` });
  assert.equal(r.status, 1);
  assert.match(r.out, /blocked-term #1 at tag/);
  assert.doesNotMatch(r.out, /acme/i);

  const dir2 = mkRepoWithOrigin();
  const base = rev(dir2, 'main');
  fs.writeFileSync(path.join(dir2, 'z.md'), 'fine\n');
  git(dir2, ['add', 'z.md']);
  git(dir2, ['commit', '-q', '-m', 'z', '--author', 'Acme Corp <x@example.invalid>']);
  r = check(dir2, ['push'], { input: pushLine(dir2, 'main', base) });
  assert.equal(r.status, 1);
  assert.match(r.out, /blocked-term #1 at commit [0-9a-f]+ author/);
});
