import { execFileSync } from 'node:child_process';

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

export function parsePushRefs(stdin) {
  return stdin.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [localRef, localSha, remoteRef, remoteSha] = l.split(/\s+/);
    return { localRef, localSha, remoteRef, remoteSha };
  });
}

export function pushRange(ref) {
  if (ZERO.test(ref.localSha)) return { kind: 'delete' };
  if (ZERO.test(ref.remoteSha)) return { kind: 'range', revs: [ref.localSha, '--not', '--remotes'] };
  return { kind: 'range', revs: [`${ref.remoteSha}..${ref.localSha}`] };
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

// Revs to scan for a push ref; shared by gitleaks and the term scan so both see the same commits.
// If the remote tip is unknown locally, fall back to commits on no remote.
export function effectiveRevs(ref, cwd = process.cwd()) {
  const range = pushRange(ref);
  if (range.kind === 'delete') return range;
  if (range.revs.length === 1 && !isCommit(ref.remoteSha, cwd)) {
    return { kind: 'range', revs: [ref.localSha, '--not', '--remotes'] };
  }
  return range;
}

function collectRange(revs, cwd) {
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

// Input for the AI confidentiality review of a push: full diffs and messages of the same
// effective revs the other checks scan, annotated-tag text, and the binary paths.
// Shared by the pre-push hook (agent shells) and the Claude Code hook. Throws on git errors.
export function reviewInputForPush(refs, cwd = process.cwd()) {
  let diff = '';
  const binaryPaths = [];
  for (const ref of refs) {
    const range = effectiveRevs(ref, cwd);
    if (range.kind === 'delete') continue;
    if (git(['cat-file', '-t', ref.localSha], cwd).trim() === 'tag') diff += git(['cat-file', 'tag', ref.localSha], cwd);
    diff += git(['log', '-p', '--text', '-m', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames',
      '--pretty=fuller', ...range.revs], cwd);
    const numstat = git(['log', '-m', '--numstat', '--no-renames', '--format=', '-z', ...range.revs], cwd);
    for (const entry of numstat.split('\0')) {
      const m = /^\n*(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(entry);
      if (m && m[1] === '-' && m[2] === '-' && !binaryPaths.includes(m[3])) binaryPaths.push(m[3]);
    }
  }
  return { diff, binaryPaths };
}
