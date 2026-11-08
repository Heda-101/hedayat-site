import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAddedLines, parsePushRefs, pushRange } from '../../scripts/guard/scope.mjs';

const Z = '0'.repeat(40);

test('parseAddedLines maps hunk line numbers', () => {
  const d = 'diff --git a/x.md b/x.md\n+++ b/x.md\n@@ -1,0 +5,2 @@\n+hello\n+world\n';
  assert.deepEqual(parseAddedLines(d), [
    { path: 'x.md', line: 5, text: 'hello' },
    { path: 'x.md', line: 6, text: 'world' },
  ]);
});

test('parseAddedLines handles several files and hunks, ignores removals', () => {
  const d = [
    'diff --git a/a.md b/a.md', 'index 1..2 100644', '--- a/a.md', '+++ b/a.md',
    '@@ -3 +3 @@', '-old', '+new',
    '@@ -10,0 +11 @@', '+added',
    'diff --git a/b.md b/b.md', '--- a/b.md', '+++ b/b.md',
    '@@ -1,2 +1,0 @@', '-gone1', '-gone2',
    'diff --git a/c.md b/c.md', 'deleted file mode 100644', '--- a/c.md', '+++ /dev/null',
    '@@ -1 +0,0 @@', '-bye', '',
  ].join('\n');
  assert.deepEqual(parseAddedLines(d), [
    { path: 'a.md', line: 3, text: 'new' },
    { path: 'a.md', line: 11, text: 'added' },
  ]);
});

test('parseAddedLines: an added line that looks like a +++ header is content', () => {
  const d = 'diff --git a/x.md b/x.md\n--- a/x.md\n+++ b/x.md\n@@ -0,0 +1,2 @@\n+++ b/fake.md\n+second\n';
  assert.deepEqual(parseAddedLines(d), [
    { path: 'x.md', line: 1, text: '++ b/fake.md' },
    { path: 'x.md', line: 2, text: 'second' },
  ]);
});

test('parseAddedLines: empty input gives no lines', () => {
  assert.deepEqual(parseAddedLines(''), []);
});

test('parsePushRefs reads hook stdin lines', () => {
  const a = 'a'.repeat(40), b = 'b'.repeat(40);
  assert.deepEqual(parsePushRefs(`refs/heads/x ${a} refs/heads/x ${b}\n\nrefs/heads/y ${a} refs/heads/y ${Z}\n`), [
    { localRef: 'refs/heads/x', localSha: a, remoteRef: 'refs/heads/x', remoteSha: b },
    { localRef: 'refs/heads/y', localSha: a, remoteRef: 'refs/heads/y', remoteSha: Z },
  ]);
  assert.deepEqual(parsePushRefs(''), []);
  assert.deepEqual(parsePushRefs(`refs/heads/x ${a} refs/heads/x ${b}\n`, 'origin'),
    [{ localRef: 'refs/heads/x', localSha: a, remoteRef: 'refs/heads/x', remoteSha: b, remote: 'origin' }]);
});

test('pushRange: new branch, deletion, update', () => {
  // a new branch is resolved against the remote's live tips (effectiveRevs), never local --remotes
  assert.deepEqual(pushRange({ localSha: 'a'.repeat(40), remoteSha: Z }), { kind: 'new' });
  assert.equal(pushRange({ localSha: Z, remoteSha: 'b'.repeat(40) }).kind, 'delete');
  assert.deepEqual(pushRange({ localSha: 'a'.repeat(40), remoteSha: 'b'.repeat(40) }),
    { kind: 'range', revs: ['b'.repeat(40) + '..' + 'a'.repeat(40)] });
});

// ---------- R22: AI review input batched by commit ----------
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { reviewBatchesForPush } from '../../scripts/guard/scope.mjs';

const tmpDirs = [];
test.after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
function sh(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) assert.fail(`git ${args[0]} failed: ${r.stderr}`);
  return r.stdout;
}
function batchRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-batch-'));
  tmpDirs.push(dir);
  sh(dir, ['init', '-q', '-b', 'main']);
  sh(dir, ['config', 'user.name', 'Test']);
  sh(dir, ['config', 'user.email', 'test@example.invalid']);
  sh(dir, ['config', 'commit.gpgsign', 'false']);
  sh(dir, ['config', 'core.hooksPath', '/dev/null']);
  fs.writeFileSync(path.join(dir, 'a.md'), 'base\n');
  sh(dir, ['add', 'a.md']);
  sh(dir, ['commit', '-q', '-m', 'base']);
  return dir;
}
const filler = (bytes, tag) => `${tag} filler line for the batch tests\n`.repeat(Math.ceil(bytes / 40));
function commit(dir, files, msg) {
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
    sh(dir, ['add', name]);
  }
  sh(dir, ['commit', '-q', '-m', msg]);
}
const head = (dir) => sh(dir, ['rev-parse', 'HEAD']).trim();
const refsFor = (dir, base) => [{ localRef: 'refs/heads/main', localSha: head(dir), remoteRef: 'refs/heads/main', remoteSha: base }];
const tooLarge = (e) => e.code === 'AI_TOO_LARGE' && /split this push/.test(e.message);

test('R22: a small push is one batch with every commit, message included', () => {
  const dir = batchRepo();
  const base = head(dir);
  commit(dir, { 'b.md': 'bee\n' }, 'first change');
  commit(dir, { 'c.md': 'sea\n' }, 'second change');
  const b = reviewBatchesForPush(refsFor(dir, base), dir);
  assert.equal(b.length, 1);
  assert.match(b[0].diff, /first change/);
  assert.match(b[0].diff, /\+sea/);
  assert.doesNotMatch(b[0].diff, /\+base/);
});

test('R22: commits are packed whole into batches of at most 200 KB', () => {
  const dir = batchRepo();
  const base = head(dir);
  for (const n of [1, 2, 3]) commit(dir, { [`f${n}.md`]: filler(80_000, `c${n}`) }, `commit ${n}`);
  const b = reviewBatchesForPush(refsFor(dir, base), dir);
  assert.equal(b.length, 2);
  for (const x of b) assert.ok(Buffer.byteLength(x.diff) <= 200_000);
  assert.match(b[0].diff, /commit 1/);
  assert.match(b[0].diff, /commit 2/);
  assert.match(b[1].diff, /commit 3/);
});

test('R22: a commit over the cap is split by file; one file over the cap blocks', () => {
  const dir = batchRepo();
  const base = head(dir);
  commit(dir, { 'x.md': filler(120_000, 'x'), 'y.md': filler(120_000, 'y') }, 'two big files');
  const b = reviewBatchesForPush(refsFor(dir, base), dir);
  assert.equal(b.length, 2);
  assert.match(b[0].diff, /two big files/);
  assert.match(b[1].diff, /two big files/);
  assert.ok(b.every((x) => Buffer.byteLength(x.diff) <= 200_000));
  commit(dir, { 'z.md': filler(250_000, 'z') }, 'one huge file');
  assert.throws(() => reviewBatchesForPush(refsFor(dir, base), dir), tooLarge);
});

test('R22: more than 10 batches blocks with split this push', () => {
  const dir = batchRepo();
  const base = head(dir);
  for (let n = 0; n < 11; n++) commit(dir, { [`g${n}.md`]: filler(150_000, `g${n}`) }, `big ${n}`);
  assert.throws(() => reviewBatchesForPush(refsFor(dir, base), dir), tooLarge);
});

test('R22: lockfiles are left out of the AI input only', () => {
  const dir = batchRepo();
  const base = head(dir);
  commit(dir, {
    'package-lock.json': filler(300_000, 'npm'), 'web/pnpm-lock.yaml': filler(1000, 'pnpm'),
    'yarn.lock': filler(1000, 'yarn'), 'Gemfile.lock': filler(1000, 'gem'), 'src/app.md': 'real change\n',
  }, 'deps and app');
  const b = reviewBatchesForPush(refsFor(dir, base), dir);
  assert.equal(b.length, 1);
  assert.match(b[0].diff, /\+real change/);
  assert.match(b[0].diff, /deps and app/);
  assert.doesNotMatch(b[0].diff, /npm filler|pnpm filler|yarn filler|gem filler/);
});

test('R22: binary paths are listed with the batch of their commit', () => {
  const dir = batchRepo();
  const base = head(dir);
  commit(dir, { 'p.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]) }, 'picture');
  const b = reviewBatchesForPush(refsFor(dir, base), dir);
  assert.deepEqual(b[0].binaryPaths, ['p.png']);
});

// ---------- F2: binaries stay out of the AI diff ----------
test('F2: a 250 KB image is listed as a binary path, not inlined into the AI diff', () => {
  const dir = batchRepo();
  const base = head(dir);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]), crypto.randomBytes(250_000)]);
  commit(dir, { 'img/shot.png': png, 'notes.md': 'caption text\n' }, 'add a screenshot');
  const b = reviewBatchesForPush(refsFor(dir, base), dir);
  assert.equal(b.length, 1);
  assert.ok(Buffer.byteLength(b[0].diff) < 5_000, `AI diff is ${Buffer.byteLength(b[0].diff)} bytes`);
  assert.deepEqual(b[0].binaryPaths, ['img/shot.png']);
  assert.match(b[0].diff, /Binary files .*img\/shot\.png differ/);
  assert.match(b[0].diff, /\+caption text/);
});

test('F2: a text file marked binary by .gitattributes is still shown to the AI', () => {
  const dir = batchRepo();
  const base = head(dir);
  commit(dir, { '.gitattributes': '*.md -diff\n*.txt binary\n', 'h.md': 'hidden words here\n', 'n.txt': 'note words here\n' }, 'attrs');
  const b = reviewBatchesForPush(refsFor(dir, base), dir);
  assert.equal(b.length, 1);
  assert.match(b[0].diff, /\+hidden words here/);
  assert.match(b[0].diff, /\+note words here/);
});

test('F2: a modified 250 KB image keeps the AI diff small', () => {
  const dir = batchRepo();
  commit(dir, { 'pic.png': Buffer.concat([Buffer.from([0x89, 0x50, 0, 0]), crypto.randomBytes(250_000)]) }, 'first');
  const base = head(dir);
  commit(dir, { 'pic.png': Buffer.concat([Buffer.from([0x89, 0x50, 0, 0]), crypto.randomBytes(250_000)]) }, 'replace');
  const b = reviewBatchesForPush(refsFor(dir, base), dir);
  assert.equal(b.length, 1);
  assert.ok(Buffer.byteLength(b[0].diff) < 5_000);
  assert.deepEqual(b[0].binaryPaths, ['pic.png']);
});

test('R22: an empty push has no batches; a deleted ref is skipped', () => {
  const dir = batchRepo();
  assert.deepEqual(reviewBatchesForPush(refsFor(dir, head(dir)), dir), []);
  assert.deepEqual(reviewBatchesForPush([{ localRef: '(delete)', localSha: Z, remoteRef: 'refs/heads/x', remoteSha: head(dir) }], dir), []);
});
