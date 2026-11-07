import { execFileSync } from 'node:child_process';

const ZERO = /^0+$/;
const MAX = 1024 * 1024 * 1024;
const MARK = '\x01GUARD-COMMIT ';

function git(args, cwd) {
  return execFileSync('git', ['-c', 'core.quotepath=off', ...args], {
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
  const diff = git(['diff', '--cached', '-U0', '-M', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/'], cwd);
  const names = git(['diff', '--cached', '--name-only', '-M', '-z'], cwd);
  return [...addedItems(diff), ...pathItems(names)];
}

function logRange(revs, cwd) {
  try {
    return collectRange(revs, cwd);
  } catch (e) {
    // remote tip unknown locally (e.g. forced update): fall back to commits on no remote
    const m = revs.length === 1 && /^([0-9a-f]+)\.\.([0-9a-f]+)$/i.exec(revs[0]);
    if (!m) throw e;
    return collectRange([m[2], '--not', '--remotes'], cwd);
  }
}

function collectRange(revs, cwd) {
  const items = [];
  const messages = git(['log', '--format=%H%x00%B%x00', ...revs], cwd).split('\0');
  for (let i = 0; i + 1 < messages.length; i += 2) {
    const sha = messages[i].trim();
    if (sha) items.push({ where: `commit ${sha.slice(0, 7)} message`, text: messages[i + 1] });
  }
  const names = git(['log', '-m', '-M', '--name-only', '-z', '--format=', ...revs], cwd);
  items.push(...pathItems(names));
  const log = git(['log', '-m', '-p', '-U0', '-M', '--no-ext-diff', '--no-textconv',
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
    const range = pushRange(ref);
    if (range.kind === 'delete') continue;
    for (const name of new Set([ref.remoteRef, ref.localRef])) {
      if (name) items.push({ where: `branch ${name}`, text: name });
    }
    items.push(...logRange(range.revs, cwd));
  }
  return items;
}
