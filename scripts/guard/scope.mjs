import { execFileSync } from 'node:child_process';
import { GuardError } from './terms.mjs';

const ZERO = /^0+$/;
const MAX = 1024 * 1024 * 1024;
const MARK = '\x01GUARD-COMMIT ';

export function git(args, cwd) {
  return execFileSync('git', ['-c', 'core.quotepath=off', '-c', 'color.ui=never', '-c', 'color.diff=never',
    '-c', 'log.showRoot=true', '-c', 'diff.relative=false', ...args], {
    cwd, encoding: 'utf8', maxBuffer: MAX, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function unquote(p) {
  if (!p.startsWith('"')) return p.replace(/\t.*$/, '');
  try { return JSON.parse(p.replace(/\t.*$/, '')); } catch { return p; }
}

export function parseAddedLines(unifiedDiff) {
  const out = [];
  let path = null;
  let line = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const raw of unifiedDiff.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      const c = raw[0];
      if (c === '+') { out.push({ path, line, text: raw.slice(1) }); line++; newLeft--; }
      else if (c === '-') oldLeft--;
      else if (c === ' ') { line++; oldLeft--; newLeft--; }
      // "\ No newline at end of file" and anything else consumes nothing
      continue;
    }
    if (raw.startsWith('diff --git ')) { path = null; continue; }
    if (raw.startsWith('+++ ')) {
      const p = unquote(raw.slice(4));
      path = p === '/dev/null' ? null : p.replace(/^b\//, '');
      continue;
    }
    const m = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (m) {
      oldLeft = m[1] === undefined ? 1 : Number(m[1]);
      line = Number(m[2]);
      newLeft = m[3] === undefined ? 1 : Number(m[3]);
    }
  }
  return out;
}

// remote is the pre-push hook's first argument (a remote name or URL); each ref carries it.
export function parsePushRefs(stdin, remote) {
  return stdin.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [localRef, localSha, remoteRef, remoteSha] = l.split(/\s+/);
    return remote === undefined ? { localRef, localSha, remoteRef, remoteSha }
      : { localRef, localSha, remoteRef, remoteSha, remote };
  });
}

// 'new' (no remote tip) is resolved against the remote's live tips by effectiveRevs.
export function pushRange(ref) {
  if (ZERO.test(ref.localSha)) return { kind: 'delete' };
  if (ZERO.test(ref.remoteSha)) return { kind: 'new' };
  return { kind: 'range', revs: [`${ref.remoteSha}..${ref.localSha}`] };
}

const LS_REMOTE_TIMEOUT_MS = 120_000;
const NO_LIST = "could not list the remote's branches and tags (git ls-remote failed); pushes need network access. Blocking";

// Branch and tag tips the remote has right now (git ls-remote) that exist here as commits.
// Local remote-tracking refs are never trusted: they go stale when a branch is deleted on the
// server. Throws GuardError (safe to print) when the remote cannot be listed.
export function liveRemoteTips(remote, cwd) {
  if (typeof remote !== 'string' || remote === '' || remote.startsWith('-')) throw new GuardError('REMOTE_UNLISTED', NO_LIST);
  let out;
  try {
    out = execFileSync('git', ['ls-remote', remote], {
      cwd, encoding: 'utf8', maxBuffer: MAX, timeout: LS_REMOTE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new GuardError('REMOTE_UNLISTED', NO_LIST);
  }
  const shas = new Set();
  for (const line of out.split('\n')) {
    const m = /^([0-9a-f]{40,64})\trefs\/(heads|tags)\/\S+$/.exec(line);
    if (m) shas.add(m[1]);
  }
  if (shas.size === 0) return [];
  // one batch lookup; objects missing here are skipped, annotated tags count via their ^{} line
  const types = execFileSync('git', ['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
    cwd, encoding: 'utf8', maxBuffer: MAX, input: `${[...shas].join('\n')}\n`, stdio: ['pipe', 'pipe', 'pipe'],
  });
  return types.split('\n').map((l) => l.split(' ')).filter(([sha, type]) => type === 'commit' && shas.has(sha)).map(([sha]) => sha);
}

function pathItems(nulList) {
  return nulList.split('\0').filter(Boolean).map((p) => ({ where: `path ${p}`, text: p }));
}

function addedItems(diff) {
  return parseAddedLines(diff).map((a) => ({ where: `${a.path}:${a.line}`, text: a.text }));
}

export function collectStaged(cwd = process.cwd()) {
  const diff = git(['diff', '--cached', '-U0', '-M', '--text', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/'], cwd);
  const names = git(['diff', '--cached', '--name-only', '-M', '-z'], cwd);
  return [...addedItems(diff), ...pathItems(names)];
}

function isCommit(sha, cwd) {
  try { git(['cat-file', '-e', `${sha}^{commit}`], cwd); return true; } catch { return false; }
}

const liveTips = new WeakMap(); // ref -> tips, so one push lists its remote once

// Revs to scan for a push ref; shared by gitleaks, the term scan, the image hold and the AI
// review so all see the same commits. A known remote tip (from git's own pre-push input) gives
// remoteSha..localSha. A new branch, or a remote tip unknown here, gives every commit not
// reachable from the remote's live branch and tag tips (all of localSha when it has none here).
export function effectiveRevs(ref, cwd = process.cwd()) {
  const range = pushRange(ref);
  if (range.kind === 'delete') return range;
  if (range.kind === 'range' && isCommit(ref.remoteSha, cwd)) return range;
  if (!liveTips.has(ref)) liveTips.set(ref, liveRemoteTips(ref.remote, cwd));
  const tips = liveTips.get(ref);
  return { kind: 'range', revs: tips.length ? [ref.localSha, '--not', ...tips] : [ref.localSha] };
}

export function collectRange(revs, cwd) {
  const items = [];
  const messages = git(['log', '--format=%H%x00%B%x00', ...revs], cwd).split('\0');
  for (let i = 0; i + 1 < messages.length; i += 2) {
    const sha = messages[i].trim();
    if (!sha) continue;
    items.push({ where: `commit ${sha.slice(0, 7)} message`, text: messages[i + 1] });
    // identity lines (name and email) live in the raw commit header
    const header = git(['cat-file', 'commit', sha], cwd).split('\n\n')[0]
      .split('\n').filter((l) => /^(author|committer) /.test(l)).join('\n');
    items.push({ where: `commit ${sha.slice(0, 7)} author`, text: header });
  }
  const names = git(['log', '-m', '-M', '--name-only', '-z', '--format=', ...revs], cwd);
  items.push(...pathItems(names));
  const log = git(['log', '-m', '-p', '-U0', '-M', '--text', '--no-color', '--no-ext-diff', '--no-textconv',
    '--src-prefix=a/', '--dst-prefix=b/', `--format=${MARK}%h`, ...revs], cwd);
  for (const chunk of log.split(MARK).slice(1)) {
    const nl = chunk.indexOf('\n');
    const short = chunk.slice(0, nl);
    for (const it of addedItems(chunk.slice(nl + 1))) items.push({ where: `${it.where} (commit ${short})`, text: it.text });
  }
  return items;
}

export function collectPush(refs, cwd = process.cwd()) {
  const items = [];
  for (const ref of refs) {
    const range = effectiveRevs(ref, cwd);
    if (range.kind === 'delete') continue;
    for (const name of new Set([ref.remoteRef, ref.localRef])) {
      if (name) items.push({ where: `branch ${name}`, text: name });
    }
    let type = '';
    try { type = git(['cat-file', '-t', ref.localSha], cwd).trim(); } catch { /* scan fails below */ }
    if (type === 'tag') {
      items.push({ where: `tag ${ref.localSha.slice(0, 7)} annotation`, text: git(['cat-file', 'tag', ref.localSha], cwd) });
    }
    items.push(...collectRange(range.revs, cwd));
  }
  return items;
}

// ---------- AI review input (R22) ----------
// The AI confidentiality review sees full diffs and messages of the same effective revs the
// other checks scan, plus annotated-tag text and binary paths. It is batched by commit so that
// no single model call sees more than MAX_BATCH_BYTES of diff: whole commits are packed in
// order; a commit over the cap is split by file; a single file over the cap, or more than
// MAX_BATCHES batches, blocks. Generated lockfiles are left out of the AI input only (the term
// scan and gitleaks still read them).
export const MAX_BATCH_BYTES = 200_000;
export const MAX_BATCHES = 10;
// Exact basenames only: a glob like *.lock would also hide files such as secrets.lock.
export const LOCKFILE_NAMES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'Cargo.lock',
  'Gemfile.lock', 'poetry.lock', 'composer.lock'];
export const LOCKFILE_PATHSPECS = LOCKFILE_NAMES.map((n) => `:(top,exclude,glob)**/${n}`);
const PATHSPEC = ['--', ':(top)', ...LOCKFILE_PATHSPECS];
// No --text here (F2): binaries show as "Binary files ... differ" and are listed in binaryPaths,
// so an image does not fill the AI cap. collectRange (gitleaks and the term scan) keeps --text.
const BASE_DIFF_OPTS = ['--root', '-m', '-r', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames'];
const SPLIT = 'split this push into smaller pushes';
const FIRST_FEW_BYTES = 8000; // git's own binary test: a NUL byte in the first 8000 bytes

const tooLarge = (what) => new GuardError('AI_TOO_LARGE', `${what} is over the ${MAX_BATCH_BYTES}-byte AI review cap; ${SPLIT}`);
const bytes = (s) => Buffer.byteLength(s);

function binaryPathsOf(sha, opts, cwd) {
  const out = [];
  const numstat = git(['diff-tree', '--numstat', '--no-commit-id', '-z', ...opts, sha, ...PATHSPEC], cwd);
  for (const entry of numstat.split('\0')) {
    const m = /^\n*(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(entry);
    if (m && m[1] === '-' && m[2] === '-' && !out.includes(m[3])) out.push(m[3]);
  }
  return out;
}

// True when git would call the file binary on content alone (no .gitattributes). A path gone
// from the commit (a deletion) counts as binary: there is no new content to show.
function contentIsBinary(sha, p, cwd) {
  let blob;
  try {
    blob = execFileSync('git', ['cat-file', 'blob', `${sha}:${p}`], { cwd, maxBuffer: MAX, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    if (typeof e.status === 'number') return true;
    throw e;
  }
  return blob.subarray(0, FIRST_FEW_BYTES).includes(0);
}

// Diff options for one commit. A text file that .gitattributes marks binary (-diff, binary)
// must not hide from the AI, so any such file puts the whole commit back on --text.
function diffOptsFor(sha, cwd) {
  const binaries = binaryPathsOf(sha, BASE_DIFF_OPTS, cwd);
  const real = binaries.filter((p) => contentIsBinary(sha, p, cwd));
  const opts = real.length < binaries.length ? [...BASE_DIFF_OPTS, '--text'] : BASE_DIFF_OPTS;
  return { opts, binaryPaths: real };
}

// One commit as review units: the whole commit, or (when over the cap) its header plus one file each.
function commitUnits(sha, cwd) {
  const short = sha.slice(0, 7);
  const { opts: diffOpts, binaryPaths } = diffOptsFor(sha, cwd);
  const whole = git(['diff-tree', '--always', '-p', '--pretty=fuller', ...diffOpts, sha, ...PATHSPEC], cwd);
  if (bytes(whole) <= MAX_BATCH_BYTES) return [{ diff: whole, binaryPaths }];
  const header = git(['show', '-s', '--pretty=fuller', sha], cwd);
  const names = [...new Set(git(['diff-tree', '--name-only', '--no-commit-id', '-z', ...diffOpts, sha, ...PATHSPEC], cwd)
    .split('\0').filter(Boolean))];
  const units = [];
  names.forEach((name, i) => {
    const diff = `${header}\n(part ${i + 1} of ${names.length})\n`
      + git(['diff-tree', '-p', '--no-commit-id', ...diffOpts, sha, '--', `:(top,literal)${name}`], cwd);
    if (bytes(diff) > MAX_BATCH_BYTES) throw tooLarge(`one file in commit ${short}`);
    units.push({ diff, binaryPaths: binaryPaths.includes(name) ? [name] : [] });
  });
  if (units.length === 0) throw tooLarge(`commit ${short}`);
  return units;
}

// Returns [{ diff, binaryPaths }] in push order; [] when nothing is new. Throws GuardError or git errors.
export function reviewBatchesForPush(refs, cwd = process.cwd()) {
  const units = [];
  const seen = new Set();
  for (const ref of refs) {
    const range = effectiveRevs(ref, cwd);
    if (range.kind === 'delete') continue;
    if (git(['cat-file', '-t', ref.localSha], cwd).trim() === 'tag') {
      const text = git(['cat-file', 'tag', ref.localSha], cwd);
      if (bytes(text) > MAX_BATCH_BYTES) throw tooLarge(`tag ${ref.localSha.slice(0, 7)}`);
      units.push({ diff: text, binaryPaths: [] });
    }
    for (const sha of git(['rev-list', '--reverse', ...range.revs], cwd).split('\n').filter(Boolean)) {
      if (seen.has(sha)) continue;
      seen.add(sha);
      units.push(...commitUnits(sha, cwd));
    }
  }
  const batches = [];
  let cur = null;
  for (const u of units) {
    if (cur && bytes(cur.diff) + bytes(u.diff) <= MAX_BATCH_BYTES) {
      cur.diff += u.diff;
      for (const p of u.binaryPaths) if (!cur.binaryPaths.includes(p)) cur.binaryPaths.push(p);
    } else {
      cur = { diff: u.diff, binaryPaths: [...u.binaryPaths] };
      batches.push(cur);
      if (batches.length > MAX_BATCHES) throw new GuardError('AI_TOO_LARGE', `this push needs more than ${MAX_BATCHES} AI review batches; ${SPLIT}`);
    }
  }
  return batches;
}
