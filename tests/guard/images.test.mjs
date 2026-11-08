import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isImagePath, heldFilesInPush, confirmImages } from '../../scripts/guard/images.mjs';

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

test('heldFilesInPush: added, renamed-to, spaced and non-ASCII paths; ignores non-images', () => {
  const dir = mkRepo();
  const base = head(dir);
  commitFiles(dir, { 'pics/one two.png': 'p1', 'pics/café.JPG': 'p2', 'doc.md': 'm', 'old.txt': 'o' });
  git(dir, ['mv', 'old.txt', 'moved.svg']);
  git(dir, ['commit', '-q', '-m', 'rename']);
  const found = heldFilesInPush([refFor(dir, base)], dir).sort();
  assert.deepEqual(found, ['moved.svg', 'pics/café.JPG', 'pics/one two.png']);
});

test('heldFilesInPush: a deleted image, a deletion push and a clean push add none', () => {
  const dir = mkRepo();
  commitFiles(dir, { 'gone.png': 'p' });
  const base = head(dir);
  git(dir, ['rm', '-q', 'gone.png']);
  git(dir, ['commit', '-q', '-m', 'rm']);
  assert.deepEqual(heldFilesInPush([refFor(dir, base)], dir), []);
  assert.deepEqual(heldFilesInPush([{ localRef: '(delete)', localSha: Z, remoteRef: 'refs/heads/x', remoteSha: base }], dir), []);
});

test('F3: a modified or type-changed image is held too', () => {
  const dir = mkRepo();
  commitFiles(dir, { 'old.png': 'first', 'kind.png': 'regular' });
  const base = head(dir);
  commitFiles(dir, { 'old.png': 'replaced with a different picture' }, 'modify');
  assert.deepEqual(heldFilesInPush([refFor(dir, base)], dir), ['old.png']);
  fs.rmSync(path.join(dir, 'kind.png'));
  fs.symlinkSync('old.png', path.join(dir, 'kind.png'));
  git(dir, ['add', 'kind.png']);
  git(dir, ['commit', '-q', '-m', 'type change']);
  assert.deepEqual(heldFilesInPush([refFor(dir, base)], dir).sort(), ['kind.png', 'old.png']);
  const r = runPush(dir, refFor(dir, base), { GUARD_TTY: '/nonexistent' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /image needs confirmation: old\.png/);
});

test('heldFilesInPush: unknown remote sha falls back to commits not on the live remote', () => {
  const dir = mkRepo();
  const origin = tmp('img-origin-');
  git(origin, ['init', '-q', '--bare', '-b', 'main']);
  git(dir, ['push', '-q', origin, 'main']);
  commitFiles(dir, { 'x.png': 'p' });
  const found = heldFilesInPush([{ ...refFor(dir, 'f'.repeat(40)), remote: origin }], dir);
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

// R23: binaries the term scan and the AI cannot read (NUL bytes, UTF-16, PDFs) are held like images.
test('R23: new or modified non-image binaries are held; deleted ones and plain text are not', () => {
  const dir = mkRepo();
  commitFiles(dir, { 'old.bin': Buffer.from([1, 0, 2]), 'gone.dat': Buffer.from([3, 0, 4]) });
  const base = head(dir);
  const utf16 = Buffer.from('﻿notes in utf sixteen\n', 'utf16le');
  commitFiles(dir, { 'nul.txt': Buffer.from('head\0 hidden words\n'), 'u16.txt': utf16, 'old.bin': Buffer.from([5, 0, 6]),
    'doc.pdf': Buffer.from('%PDF-1.4\n\0\0 body'), 'plain.md': 'just text\n' });
  git(dir, ['rm', '-q', 'gone.dat']);
  git(dir, ['commit', '-q', '-m', 'rm']);
  assert.deepEqual(heldFilesInPush([refFor(dir, base)], dir).sort(), ['doc.pdf', 'nul.txt', 'old.bin', 'u16.txt']);
});

test('R23: check push holds a NUL-byte .txt and a UTF-16 file without a tty; y confirms', () => {
  const dir = mkRepo();
  const base = head(dir);
  commitFiles(dir, { 'nul.txt': Buffer.from('a\0b\n'), 'u16.txt': Buffer.from('﻿hello\n', 'utf16le') });
  const ref = refFor(dir, base);
  const r = runPush(dir, ref, { GUARD_TTY: '/nonexistent' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /binary file needs confirmation: nul\.txt/);
  assert.match(r.stdout, /binary file needs confirmation: u16\.txt/);
  assert.equal(runPush(dir, ref, { GUARD_TTY: tty('y\n') }).status, 0);
  assert.equal(runPush(dir, ref, { GUARD_TTY: tty('n\n') }).status, 1);
});

// Fix round 2: "binary" is decided from content, never from .gitattributes.
const gz = (s) => zlib.gzipSync(Buffer.from(s));
const utf16 = (s) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]);

test('R23b: an in-tree "diff" attribute does not hide a gzip or a UTF-16 file', () => {
  const dir = mkRepo();
  const base = head(dir);
  commitFiles(dir, { '.gitattributes': '*.dat diff\n*.txt diff\n', 'notes2.dat': gz('Zebra Quartz secret notes\n'), 'u2.txt': utf16('hello world\n') });
  assert.deepEqual(heldFilesInPush([refFor(dir, base)], dir).sort(), ['.gitattributes', 'notes2.dat', 'u2.txt']);
});

test('R23b: .git/info/attributes does not hide a UTF-16 file', () => {
  const dir = mkRepo();
  const base = head(dir);
  fs.mkdirSync(path.join(dir, '.git/info'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git/info/attributes'), '*.txt diff\n*.dat diff\n');
  commitFiles(dir, { 'u3.txt': utf16('hello world\n'), 'n.dat': gz('more notes\n') });
  assert.deepEqual(heldFilesInPush([refFor(dir, base)], dir).sort(), ['n.dat', 'u3.txt']);
});

test('R23b: a UTF-16 file with no NUL byte (BOM check) and invalid UTF-8 are held', () => {
  const dir = mkRepo();
  const base = head(dir);
  const cjk = utf16('漢字テスト');
  assert.equal(cjk.includes(0), false);
  commitFiles(dir, { 'cjk.txt': cjk, 'be.txt': Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from([0x6f, 0x22])]),
    'raw.bin': Buffer.from([0xc3, 0x28, 0xa0, 0xa1, 0x41]), 'ok.md': 'café — fine\n' });
  assert.deepEqual(heldFilesInPush([refFor(dir, base)], dir).sort(), ['be.txt', 'cjk.txt', 'raw.bin']);
});

test('R23b: changing .gitattributes needs confirmation; agents are held', () => {
  const dir = mkRepo();
  commitFiles(dir, { '.gitattributes': '*.md text\n' });
  const base = head(dir);
  commitFiles(dir, { '.gitattributes': '*.md text\n*.txt diff\n', 'sub/.gitattributes': '* -diff\n' });
  const r = runPush(dir, refFor(dir, base), { GUARD_TTY: '/nonexistent' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /attributes file needs confirmation: \.gitattributes/);
  assert.match(r.stdout, /attributes file needs confirmation: sub\/\.gitattributes/);
  assert.equal(runPush(dir, refFor(dir, base), { GUARD_TTY: tty('y\n') }).status, 0);
});

test('R23b: an .md/.astro/.css-only agent push has no hold and passes', () => {
  const dir = mkRepo();
  const base = head(dir);
  commitFiles(dir, { 'n1.md': '# hi\n', 'src/x/A.astro': '<h1>hi</h1>\n', 'src/x/a.css': 'a{color:red}\n' });
  commitFiles(dir, { 'n1.md': '# hi\nmore\n' }, 'more');
  const r = runPush(dir, refFor(dir, base), {
    CLAUDECODE: '1', GUARD_AI_CMD: path.join(ROOT, 'tests/guard/fixtures/fake-claude-pass.sh'), GUARD_TTY: '/nonexistent' });
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /needs confirmation/);
  assert.match(r.out, /AI review passed/);
});

test('R23: the prompt names images and binary files', () => {
  const f = tty('n\n');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const { confirmImages } = await import(${JSON.stringify(path.join(ROOT, 'scripts/guard/images.mjs'))}); confirmImages(['a.bin'], ${JSON.stringify(f)});`],
  { encoding: 'utf8' });
  assert.match(r.stderr, /binary files/);
});

test('check push: no images means no prompt and pass', () => {
  const dir = mkRepo();
  const base = head(dir);
  commitFiles(dir, { 'b.md': 'text' });
  assert.equal(runPush(dir, refFor(dir, base), { GUARD_TTY: '/nonexistent' }).status, 0);
});

// F2: a large image is held as an image, and once a human confirms it the AI review is not
// refused for size (the image is listed, not inlined).
test('F2: a 250 KB image push gets the image hold, not AI_TOO_LARGE', () => {
  const dir = mkRepo();
  const base = head(dir);
  commitFiles(dir, { 'shot.png': Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]), crypto.randomBytes(250_000)]) });
  const ref = refFor(dir, base);
  const agent = { CLAUDECODE: '1', GUARD_AI_CMD: path.join(ROOT, 'tests/guard/fixtures/fake-claude-pass.sh') };
  const held = runPush(dir, ref, { ...agent, GUARD_TTY: '/nonexistent' });
  assert.equal(held.status, 1);
  assert.match(held.out, /image needs confirmation: shot\.png/);
  assert.doesNotMatch(held.out, /AI_TOO_LARGE|split this push/);
  const confirmed = runPush(dir, ref, { ...agent, GUARD_TTY: tty('y\n') });
  assert.equal(confirmed.status, 0, confirmed.out);
  assert.match(confirmed.out, /AI review passed \(1 batch\)/);
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
