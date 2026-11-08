import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isImagePath, newImagesInPush, confirmImages } from '../../scripts/guard/images.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHECK = path.join(ROOT, 'scripts/guard/check.mjs');
const Z = '0'.repeat(40);

const dirs = [];
function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) assert.fail(`git ${args[0]} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function mkRepo() {
  const dir = tmp('img-repo-');
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'user.email', 'test@example.invalid']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'a.md'), 'base\n');
  git(dir, ['add', 'a.md']);
  git(dir, ['commit', '-q', '-m', 'base']);
  return dir;
}

function commitFiles(dir, files, msg = 'c') {
  for (const [p, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), c);
    git(dir, ['add', '--', p]);
  }
  git(dir, ['commit', '-q', '-m', msg]);
}

const head = (dir) => git(dir, ['rev-parse', 'HEAD']);
const refFor = (dir, remoteSha) => ({ localRef: 'refs/heads/main', localSha: head(dir), remoteRef: 'refs/heads/main', remoteSha });

function tty(content) {
  const f = path.join(tmp('img-tty-'), 'tty');
  fs.writeFileSync(f, content);
  return f;
}

// Tests run inside Claude Code shells; CLAUDECODE would switch on the AI review (R18a).
function baseEnv() { const e = { ...process.env }; delete e.CLAUDECODE; return e; }

function runPush(dir, ref, env = {}) {
  const input = `${ref.localRef} ${ref.localSha} ${ref.remoteRef} ${ref.remoteSha}\n`;
  const terms = path.join(tmp('img-terms-'), 't.txt');
  fs.writeFileSync(terms, 'Zebra Quartz\n');
  const r = spawnSync(process.execPath, [CHECK, 'push'], {
    cwd: dir, input, encoding: 'utf8', env: { ...baseEnv(), GUARD_TERMS_FILE: terms, ...env },
  });
  return { status: r.status, out: r.stdout + r.stderr, stdout: r.stdout };
}

test('isImagePath: extensions, case-insensitive', () => {
  assert.equal(isImagePath('a/B.PNG'), true);
  for (const e of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'heic', 'bmp', 'tiff', 'ico']) {
    assert.equal(isImagePath(`x.${e}`), true, e);
  }
  assert.equal(isImagePath('a.md'), false);
  assert.equal(isImagePath('png'), false);
  assert.equal(isImagePath('a.png.txt'), false);
});

test('confirmImages: y confirms, empty/other/missing tty do not', () => {
  assert.equal(confirmImages(['x.png'], tty('y\n')), true);
  assert.equal(confirmImages(['x.png'], tty('Y\n')), true);
  assert.equal(confirmImages(['x.png'], tty('\n')), false);
  assert.equal(confirmImages(['x.png'], tty('')), false);
  assert.equal(confirmImages(['x.png'], tty('yes please\n')), false);
  assert.equal(confirmImages(['x.png'], '/nonexistent/tty'), false);
});

test('newImagesInPush: added, renamed-to, spaced and non-ASCII paths; ignores non-images', () => {
  const dir = mkRepo();
  const base = head(dir);
  commitFiles(dir, { 'pics/one two.png': 'p1', 'pics/café.JPG': 'p2', 'doc.md': 'm', 'old.txt': 'o' });
  git(dir, ['mv', 'old.txt', 'moved.svg']);
  git(dir, ['commit', '-q', '-m', 'rename']);
  const found = newImagesInPush([refFor(dir, base)], dir).sort();
  assert.deepEqual(found, ['moved.svg', 'pics/café.JPG', 'pics/one two.png']);
});

test('newImagesInPush: a deleted image, a deletion push and a clean push add none', () => {
  const dir = mkRepo();
  commitFiles(dir, { 'gone.png': 'p' });
  const base = head(dir);
  git(dir, ['rm', '-q', 'gone.png']);
  git(dir, ['commit', '-q', '-m', 'rm']);
  assert.deepEqual(newImagesInPush([refFor(dir, base)], dir), []);
  assert.deepEqual(newImagesInPush([{ localRef: '(delete)', localSha: Z, remoteRef: 'refs/heads/x', remoteSha: base }], dir), []);
});

test('newImagesInPush: unknown remote sha falls back to commits on no remote', () => {
  const dir = mkRepo();
  commitFiles(dir, { 'x.png': 'p' });
  const found = newImagesInPush([refFor(dir, 'f'.repeat(40))], dir);
  assert.deepEqual(found, ['x.png']);
});

test('check push: new image blocks without a tty', () => {
  const dir = mkRepo();
  const base = head(dir);
  commitFiles(dir, { 'x.png': 'p' });
  const r = runPush(dir, refFor(dir, base), { GUARD_TTY: '/nonexistent' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /image needs confirmation: x\.png/);
});

test('check push: new image passes when confirmed, blocks when declined', () => {
  const dir = mkRepo();
  const base = head(dir);
  commitFiles(dir, { 'x.png': 'p' });
  const ref = refFor(dir, base);
  assert.equal(runPush(dir, ref, { GUARD_TTY: tty('y\n') }).status, 0);
  assert.equal(runPush(dir, ref, { GUARD_TTY: tty('n\n') }).status, 1);
});

test('check push: no images means no prompt and pass', () => {
  const dir = mkRepo();
  const base = head(dir);
  commitFiles(dir, { 'b.md': 'text' });
  assert.equal(runPush(dir, refFor(dir, base), { GUARD_TTY: '/nonexistent' }).status, 0);
});

test('check push: image path containing a blocked term is masked in output', () => {
  const dir = mkRepo();
  const base = head(dir);
  commitFiles(dir, { 'zebra quartz.png': 'p' });
  const r = runPush(dir, refFor(dir, base), { GUARD_TTY: '/nonexistent' });
  // the term scan blocks first (path match); image hold never prints the path
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.out, /zebra quartz/i);
});
