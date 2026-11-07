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
});

test('pushRange: new branch, deletion, update', () => {
  assert.deepEqual(pushRange({ localSha: 'a'.repeat(40), remoteSha: Z }).revs, ['a'.repeat(40), '--not', '--remotes']);
  assert.equal(pushRange({ localSha: Z, remoteSha: 'b'.repeat(40) }).kind, 'delete');
  assert.deepEqual(pushRange({ localSha: 'a'.repeat(40), remoteSha: 'b'.repeat(40) }),
    { kind: 'range', revs: ['b'.repeat(40) + '..' + 'a'.repeat(40)] });
});
