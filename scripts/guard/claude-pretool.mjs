// Claude Code PreToolUse hook for Bash (layer 3 of the commit/push guard).
// Denies attempts to bypass the git hooks; on an agent `git push` it re-runs the
// deterministic push checks plus the AI confidentiality review.
// Exit 0 = allow, exit 2 = block (reason on stderr). Exit 1 is never used: Claude Code
// treats it as non-blocking, so every error on a git-related command becomes exit 2.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const NESTED = 'nested shell around git is not allowed for agents';
const PUSH_ONLY = 'agents push only the current branch; ask Hedayat for anything else';
const HOOKS = 'bypassing or changing the git hooks is not allowed for agents';
const GUARD_VARS = 'guard settings cannot be changed by agents';
const GIT_ENV = 'git environment overrides are not allowed for agents';
const UNPARSABLE = 'could not parse this command safely; use a plain git command';
const Z = '0'.repeat(40);

// Removes quoting so `g''it` or `--n"o-verify` still read as what the shell will run.
const dequote = (s) => s.replace(/['"\\]/g, '');
const mentionsRaw = (s) => /git/i.test(s) || /GUARD_/.test(s);
export const mentions = (s) => mentionsRaw(s) || mentionsRaw(dequote(s));

const deny = (reason) => ({ action: 'deny', reason });
const ALLOW = Object.freeze({ action: 'allow' });

// ---------- lexer ----------
// Splits a bash command into parts (on newlines ; & | ( ) and their doubles) and words,
// honouring quotes, escapes, $(...), backticks, <(...), heredocs and comments.
// Command substitutions are lexed recursively and recorded in `substs`.

function lex(src, start = 0, depth = 0, out = { substs: [] }) {
  const parts = [];
  let part = { toks: [], redirOut: false };
  let cur = null; // { v, dyn }
  let pendingHeredocs = [];
  let i = start;

  const word = () => { if (!cur) cur = { v: '', dyn: false }; return cur; };
  const endTok = () => { if (cur) { part.toks.push(cur); cur = null; } };
  const endPart = () => { endTok(); if (part.toks.length) parts.push(part); part = { toks: [], redirOut: false }; };

  function subst(open) {
    // open is the index of the first char after `$(`, `<(` or `>(`
    const inner = lex(src, open, depth + 1, out);
    if (inner.error) return inner;
    out.substs.push({ text: src.slice(open, inner.end), parts: inner.parts });
    const w = word();
    w.v += src.slice(open - 2, inner.end + 1);
    w.dyn = true;
    return { end: inner.end + 1 };
  }

  function backtick(open) {
    let j = open;
    let body = '';
    while (j < src.length && src[j] !== '`') {
      if (src[j] === '\\' && j + 1 < src.length) { body += src[j + 1]; j += 2; continue; }
      body += src[j++];
    }
    if (j >= src.length) return { error: true };
    const inner = lex(body, 0, 0, out);
    if (inner.error) return inner;
    out.substs.push({ text: body, parts: inner.parts });
    const w = word();
    w.v += src.slice(open - 1, j + 1);
    w.dyn = true;
    return { end: j + 1 };
  }

  function readHeredocs(j) {
    // j is just after a newline; consume each pending heredoc body
    for (const h of pendingHeredocs) {
      let body = '';
      for (;;) {
        if (j >= src.length) break;
        let nl = src.indexOf('\n', j);
        if (nl === -1) nl = src.length;
        const line = src.slice(j, nl);
        j = nl + 1;
        if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
        body += `${line}\n`;
      }
      out.heredocs = (out.heredocs || '') + body;
    }
    pendingHeredocs = [];
    return j;
  }

  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      if (src[i + 1] === '\n') { i += 2; continue; }
      if (i + 1 < src.length) { word().v += src[i + 1]; i += 2; continue; }
      i++; continue;
    }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j === -1) return { error: true };
      word().v += src.slice(i + 1, j);
      i = j + 1; continue;
    }
    if (c === '$' && src[i + 1] === "'") {
      // ANSI-C quoting can spell anything; mark it dynamic
      let j = i + 2;
      while (j < src.length && src[j] !== "'") j += src[j] === '\\' ? 2 : 1;
      if (j >= src.length) return { error: true };
      const w = word(); w.v += src.slice(i, j + 1); w.dyn = true; w.ansi = true;
      i = j + 1; continue;
    }
    if (c === '"') {
      let j = i + 1;
      const w = word();
      let closed = false;
      while (j < src.length) {
        const d = src[j];
        if (d === '"') { closed = true; j++; break; }
        if (d === '\\') {
          if ('$`"\\\n'.includes(src[j + 1])) { if (src[j + 1] !== '\n') w.v += src[j + 1]; j += 2; continue; }
          w.v += d; j++; continue;
        }
        if (d === '$' && src[j + 1] === '(') {
          const r = subst(j + 2); if (r.error) return r; j = r.end; continue;
        }
        if (d === '`') { const r = backtick(j + 1); if (r.error) return r; j = r.end; continue; }
        if (d === '$') w.dyn = true;
        w.v += d; j++;
      }
      if (!closed) return { error: true };
      i = j; continue;
    }
    if (c === '$' && src[i + 1] === '(') { const r = subst(i + 2); if (r.error) return r; i = r.end; continue; }
    if ((c === '<' || c === '>') && src[i + 1] === '(') { const r = subst(i + 2); if (r.error) return r; i = r.end; continue; }
    if (c === '`') { const r = backtick(i + 1); if (r.error) return r; i = r.end; continue; }
    if (c === '$') { word().dyn = true; word().v += c; i++; continue; }
    if (c === ' ' || c === '\t') { endTok(); i++; continue; }
    if (c === '#' && !cur) { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '\n') { endPart(); i = readHeredocs(i + 1); continue; }
    if (c === ')') {
      if (depth > 0) { endPart(); return { parts, end: i }; }
      endPart(); i++; continue;
    }
    if (c === ';' || c === '|' || c === '(') { endPart(); i++; continue; }
    if (c === '&') {
      if (src[i + 1] === '>') { endTok(); part.redirOut = true; i += 2; if (src[i] === '>') i++; continue; }
      endPart(); i++; continue;
    }
    if (c === '<' || c === '>') {
      // a bare fd number right before the operator (2>&1) is not a word
      if (cur && /^\d+$/.test(cur.v) && !cur.dyn) cur = null;
      endTok();
      if (c === '>') part.redirOut = true;
      let j = i + 1;
      if (c === '<' && src[j] === '<' && src[j + 1] !== '<') {
        // heredoc
        j++;
        let strip = false;
        if (src[j] === '-') { strip = true; j++; }
        while (src[j] === ' ' || src[j] === '\t') j++;
        let delim = '';
        while (j < src.length && !' \t\n;&|<>()'.includes(src[j])) delim += src[j++];
        delim = dequote(delim);
        if (!delim) return { error: true };
        pendingHeredocs.push({ delim, strip });
        i = j; continue;
      }
      while (j < src.length && (src[j] === '<' || src[j] === '>')) j++;
      if (src[j] === '&' || src[j] === '|') j++;
      i = j; continue;
    }
    word().v += c; i++;
  }
  if (depth > 0) return { error: true };
  endPart();
  return { parts, end: i, substs: out.substs, heredocs: out.heredocs || '' };
}

// ---------- classification ----------

const KNOWN_GIT = new Set(('add am annotate apply archive bisect blame branch bundle cat-file check-attr check-ignore '
  + 'check-mailmap check-ref-format checkout cherry cherry-pick clean clone column commit commit-graph config '
  + 'count-objects describe diff diff-files diff-index diff-tree difftool fetch for-each-ref format-patch fsck gc '
  + 'get-tar-commit-id grep hash-object help init interpret-trailers log ls-files ls-remote ls-tree maintenance '
  + 'merge merge-base merge-file mergetool mv name-rev notes prune pull push range-diff rebase reflog remote repack '
  + 'request-pull reset restore rev-list rev-parse revert rm shortlog show show-branch show-ref sparse-checkout '
  + 'stash status stripspace submodule switch tag var verify-commit verify-tag version whatchanged worktree').split(' '));
// Commands that write objects or refs without running commit hooks, or push without pre-push.
const GIT_LOWLEVEL = new Set(['commit-tree', 'update-ref', 'replace', 'filter-branch', 'filter-repo', 'fast-import',
  'mktree', 'write-tree', 'read-tree', 'symbolic-ref', 'send-pack', 'http-push', 'receive-pack', 'update-index',
  'gui', 'citool']);
const GIT_READONLY = new Set(['status', 'diff', 'log', 'show', 'blame', 'annotate', 'ls-files', 'ls-tree', 'grep',
  'shortlog', 'whatchanged', 'cat-file']);
const GIT_RUNS_COMMANDS = new Set(['submodule', 'rebase', 'bisect', 'worktree', 'mergetool', 'difftool']);
const SAFE_DASH_C = /^(color\.[\w.-]+|core\.quotepath|log\.[\w.-]+|diff\.(relative|renames|noprefix|mnemonicprefix)|advice\.[\w.-]+|user\.(name|email)|init\.defaultbranch|commit\.gpgsign|pull\.rebase|pull\.ff|merge\.ff|status\.[\w.-]+|fetch\.prune)=/i;
const GIT_GLOBAL_FLAGS = new Set(['-p', '-P', '--paginate', '--no-pager', '--no-replace-objects', '--literal-pathspecs',
  '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-optional-locks', '--no-advice', '--version',
  '--help', '-h']);
const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'eval', 'source', '.',
  'xargs', 'parallel', 'python', 'python2', 'python3', 'node', 'deno', 'bun', 'perl', 'ruby', 'php', 'lua', 'osascript',
  'su', 'sudo', 'doas', 'watch', 'script', 'expect', 'awk', 'gawk', 'find', 'fd', 'trap', 'exec', 'alias']);
const READONLY_CMDS = new Set(['cat', 'ls', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'wc', 'file',
  'stat', 'diff', 'bat', 'shellcheck', 'shasum', 'md5', 'od', 'xxd', 'hexdump', 'test', '[']);
const WHERE_CMDS = new Set(['which', 'type', 'whereis', 'man', 'brew', 'apropos']);
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'fi', 'done']);
const ALLOWED_GIT_ENV = new Set(['GIT_PAGER', 'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'GIT_TERMINAL_PROMPT']);

function globalChecks(text) {
  for (const t of [text, dequote(text)]) {
    if (/GUARD_/.test(t)) return deny(GUARD_VARS);
    if (/--no-v/i.test(t) || /hooks-?path/i.test(t)) return deny(HOOKS);
    if (/--git-dir|--work-tree|--exec-path|--namespace|--super-prefix/i.test(t)) return deny(GIT_ENV);
    if (/\.git\/(config|hooks)|config\.worktree/i.test(t)) return deny(HOOKS);
    for (const m of t.matchAll(/\bGIT_[A-Z0-9_]+/g)) if (!ALLOWED_GIT_ENV.has(m[0])) return deny(GIT_ENV);
  }
  return null;
}

const base = (w) => path.basename(w);
const isAssign = (t) => !t.dyn && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t.v);

// Strips env assignments, shell keywords and transparent wrappers. Returns the remaining words.
function unwrap(toks) {
  let t = toks.slice();
  for (let guard = 0; guard < 50 && t.length; guard++) {
    const w = t[0].v;
    if (KEYWORDS.has(w) || isAssign(t[0])) { t = t.slice(1); continue; }
    const b = t[0].dyn ? w : base(w);
    if (b === 'command' || b === 'builtin') {
      if (t[1] && /^-[vV]$/.test(t[1].v)) return { where: true, toks: t };
      t = t.slice(1); while (t[0] && t[0].v === '-p') t = t.slice(1); continue;
    }
    if (b === 'nohup' || b === 'time' || b === 'nice' || b === 'timeout' || b === 'stdbuf' || b === 'env') {
      t = t.slice(1);
      // options (and their values) of these wrappers
      while (t[0] && (t[0].v.startsWith('-') || isAssign(t[0]) || (b === 'timeout' && /^\d/.test(t[0].v)))) {
        if (b === 'env' && /^-(S|-split-string)/.test(t[0].v)) return { nested: true, toks: t };
        const takesValue = (b === 'nice' && t[0].v === '-n') || (b === 'env' && /^-[uC]$/.test(t[0].v))
          || (b === 'timeout' && /^-[sk]$/.test(t[0].v));
        t = t.slice(takesValue ? 2 : 1);
      }
      if (b === 'timeout' && t[0] && /^\d/.test(t[0].v)) t = t.slice(1);
      continue;
    }
    break;
  }
  return { toks: t };
}

function classifyGit(args, ctx) {
  let i = 0;
  let hasC = false;
  while (i < args.length && args[i].v.startsWith('-')) {
    const a = args[i];
    if (a.dyn) return deny(NESTED);
    if (a.v === '-C') { if (!args[i + 1]) return deny(UNPARSABLE); hasC = true; i += 2; continue; }
    if (a.v === '-c') {
      const kv = args[i + 1];
      if (!kv || kv.dyn || !SAFE_DASH_C.test(kv.v)) return deny(`git -c with that setting is not allowed for agents (${HOOKS})`);
      i += 2; continue;
    }
    if (GIT_GLOBAL_FLAGS.has(a.v)) { i++; continue; }
    return deny('unrecognized git option; use a plain git command');
  }
  const subTok = args[i];
  if (!subTok) return ALLOW;
  if (subTok.dyn) return deny(NESTED);
  const sub = subTok.v;
  const rest = args.slice(i + 1);
  if (GIT_LOWLEVEL.has(sub)) return deny(`git ${sub} is not allowed for agents (it can skip the hooks)`);
  if (!KNOWN_GIT.has(sub)) return deny('unknown git subcommand; git aliases are not allowed for agents');

  // Expansions in git arguments can spell anything; only a commit/tag message value may use $(...).
  for (let k = 0; k < rest.length; k++) {
    const t = rest[k];
    if (t.ansi) return deny(NESTED);
    if (!t.dyn) continue;
    const prev = k > 0 ? rest[k - 1].v : '';
    const isMessage = ['commit', 'tag', 'stash', 'notes', 'merge'].includes(sub)
      && (['-m', '--message', '-F', '--file'].includes(prev) || /^(-m|--message=)/.test(t.v));
    if (!isMessage) return deny('shell expansions in git arguments are not allowed for agents');
  }
  if (sub === 'remote' && rest.some((t) => /^(add|set-url|rename|remove|rm|set-head|set-branches|prune|update)$/.test(t.v))) {
    return deny(PUSH_ONLY);
  }
  if ((sub === 'fetch' || sub === 'pull') && rest.some((t) => t.v.includes(':') || t.v === '.' || /^(\.|\/|~)/.test(t.v)
    || /^--(upload-pack|refmap)/.test(t.v))) {
    return deny('agents fetch only from origin without refspecs');
  }
  if (rest.some((t) => /\.githooks/i.test(dequote(t.v))) && !GIT_READONLY.has(sub)) {
    return deny('agents may only read .githooks');
  }
  if (GIT_RUNS_COMMANDS.has(sub) && rest.some((t) => t.dyn || /git/i.test(dequote(t.v)))) return deny(NESTED);

  if (sub === 'commit' || sub === 'merge' || sub === 'am' || sub === 'rebase' || sub === 'cherry-pick' || sub === 'revert') {
    if (sub === 'commit' && rest.some((t) => /^-[A-Za-z]*n[A-Za-z]*$/.test(t.v))) return deny(HOOKS);
  }

  if (sub === 'config') {
    for (const t of rest) {
      const v = dequote(t.v);
      if (t.dyn) return deny(NESTED);
      if (/hook|include|alias/i.test(v) || /^(push|remote|branch|core)\./i.test(v)
        || /^(--remove-section|--rename-section|--edit|-e|--file|-f|--blob|--replace-all)(=|$)/.test(v)
        || /\bgit\b/i.test(v)) {
        return deny(HOOKS);
      }
    }
  }

  if (sub === 'push') {
    if (hasC || ctx.hasCd) return deny(`${PUSH_ONLY} (push from the project directory)`);
    const branch = ctx.branch();
    if (!branch) return deny(`detached HEAD: ${PUSH_ONLY}`);
    if (branch === 'main') return deny(PUSH_ONLY);
    if (rest.some((t) => t.dyn || /[{}$*?[\]~\\^:@]/.test(t.v))) return deny(PUSH_ONLY);
    const v = rest.map((t) => t.v);
    const ok = v.length === 0
      || (v.length === 2 && v[0] === 'origin' && v[1] === branch)
      || (v.length === 3 && v[0] === '-u' && v[1] === 'origin' && v[2] === branch);
    if (!ok) return deny(PUSH_ONLY);
    return { action: 'push', remote: 'origin', branch };
  }
  return ALLOW;
}

function classifyPart(part, ctx, nested) {
  const u = unwrap(part.toks);
  if (u.nested) return deny(NESTED);
  const toks = u.toks;
  if (!toks.length) return ALLOW;
  const first = toks[0];
  if (first.dyn) return ctx.mentioned ? deny('dynamic command names are not allowed alongside git') : ALLOW;
  const b = base(first.v);
  if (u.where) return ALLOW; // command -v git
  const anyHooksDir = toks.some((t) => /\.githooks/i.test(dequote(t.v)));
  if (b === 'git') {
    if (nested) return deny(NESTED);
    if (part.redirOut && anyHooksDir) return deny('agents may only read .githooks');
    return classifyGit(toks.slice(1), ctx);
  }
  if (INTERPRETERS.has(b) && ctx.mentioned) return deny(NESTED);
  if (toks.some((t) => t.ansi) && ctx.mentioned) return deny(NESTED);
  if (!WHERE_CMDS.has(b) && toks.slice(1).some((t) => base(dequote(t.v)) === 'git')) return deny(NESTED);
  if (anyHooksDir && (!READONLY_CMDS.has(b) || part.redirOut)) return deny('agents may only read .githooks');
  return ALLOW;
}

// classifyCommand(cmd, { branch }) -> allow | deny(reason) | push(remote, branch).
// `branch` is the current branch name, null for a detached HEAD, or a function returning either.
export function classifyCommand(cmd, opts = {}) {
  if (typeof cmd !== 'string') return deny(UNPARSABLE);
  const mentioned = mentions(cmd);
  if (!mentioned && !/\.githooks/i.test(cmd)) return ALLOW;
  const g = globalChecks(cmd);
  if (g) return g;
  const lexed = lex(cmd);
  if (lexed.error) return deny(UNPARSABLE);
  let cachedBranch;
  const ctx = {
    mentioned,
    branch: () => {
      if (cachedBranch === undefined) cachedBranch = typeof opts.branch === 'function' ? opts.branch() : (opts.branch ?? null);
      return cachedBranch;
    },
    hasCd: false,
  };
  const all = lexed.parts.map((p) => ({ p, nested: false }));
  for (const s of lexed.substs) {
    if (mentions(s.text)) return deny(NESTED);
    for (const p of s.parts) all.push({ p, nested: true });
  }
  for (const { p } of all) {
    const u = unwrap(p.toks).toks;
    if (u[0] && ['cd', 'pushd', 'popd'].includes(base(u[0].v))) ctx.hasCd = true;
  }
  let push = null;
  for (const { p, nested } of all) {
    const r = classifyPart(p, ctx, nested);
    if (r.action === 'deny') return r;
    if (r.action === 'push') push = r;
  }
  return push || ALLOW;
}

// ---------- hook entry point ----------

function say(fd, lines) {
  const text = (Array.isArray(lines) ? lines : [lines]).map((l) => `${l}\n`).join('');
  try { fs.writeSync(fd, text); } catch { /* nothing more we can do */ }
}
function block(lines) { say(2, lines); process.exit(2); }
function allow() { process.exit(0); }

function currentBranch(cwd) {
  try {
    return execFileSync('git', ['symbolic-ref', '--short', '-q', 'HEAD'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch (e) {
    if (typeof e.status === 'number') return null; // detached HEAD or not a repository
    throw e; // could not run git at all
  }
}

const clean = (s) => String(s).replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, 300);

async function pushFlow(cwd, branch) {
  const { git, effectiveRevs } = await import('./scope.mjs');
  const { runPushChecks, loadGuardTerms } = await import('./check.mjs');
  const { reviewDiff } = await import('./ai-review.mjs');
  const { findTerms } = await import('./terms.mjs');

  let terms;
  try { terms = loadGuardTerms(); } catch (e) { block(`guard: ${e.message}`); }
  const mask = (s) => (findTerms(s, terms).length ? '[withheld]' : s);

  const localSha = git(['rev-parse', '--verify', 'HEAD^{commit}'], cwd).trim();
  let remoteSha = Z;
  try { remoteSha = git(['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}^{commit}`], cwd).trim() || Z; }
  catch { remoteSha = Z; }
  const ref = `refs/heads/${branch}`;
  const refs = [{ localRef: ref, localSha, remoteRef: ref, remoteSha }];

  // Make sure git would push exactly this branch to origin/<branch>.
  const cfg = (key) => { try { return git(['config', '--get', key], cwd).trim(); } catch { return ''; } };
  const pushDefault = cfg('push.default');
  if (!['', 'simple', 'current', 'upstream'].includes(pushDefault)) block(`guard: push.default is ${clean(pushDefault)}; ${PUSH_ONLY}`);
  if (cfg('remote.origin.mirror') || cfg('remote.origin.push')) block(`guard: origin has a mirror or push refspec configured; ${PUSH_ONLY}`);
  let pushTarget = '';
  try { pushTarget = git(['rev-parse', '--abbrev-ref', `${branch}@{push}`], cwd).trim(); } catch { pushTarget = ''; }
  if (pushTarget && pushTarget !== `origin/${branch}`) block(`guard: this branch pushes to ${mask(clean(pushTarget))}; ${PUSH_ONLY}`);

  const checks = runPushChecks(refs, { cwd, terms }); // no tty: any new image blocks
  if (!checks.ok) {
    const lines = checks.lines.map((l) => `guard: ${l.replace(/^guard: /, '')}`);
    if (checks.images.length) lines.push('guard: Hedayat must push image changes himself');
    block(lines);
  }

  const range = effectiveRevs(refs[0], cwd);
  if (range.kind === 'delete') allow();
  const diff = git(['log', '-p', '--text', '-m', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames',
    '--pretty=fuller', ...range.revs], cwd);
  if (diff.trim() === '') { say(1, 'guard: nothing new to push'); allow(); }
  const binaryPaths = [];
  const numstat = git(['log', '-m', '--numstat', '--no-renames', '--format=', '-z', ...range.revs], cwd);
  for (const entry of numstat.split('\0')) {
    const m = /^\n*(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(entry);
    if (m && m[1] === '-' && m[2] === '-' && !binaryPaths.includes(m[3])) binaryPaths.push(m[3]);
  }

  let verdict;
  try { verdict = await reviewDiff(diff, binaryPaths); } catch (e) {
    block(`guard: AI review failed, blocking (${clean(e && e.code ? e.code : 'error')}): ${mask(clean(e && e.message ? e.message : ''))}`);
  }
  if (verdict.verdict !== 'pass') {
    const lines = verdict.findings.map((f) => `guard: ${mask(clean(f.file))}:${f.line}: ${mask(clean(f.reason))}`);
    lines.push('guard: AI review blocked this push');
    block(lines);
  }
  say(1, 'guard: push checks and AI review passed');
  allow();
}

export async function main() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch { raw = ''; }
  let input = null;
  try { input = JSON.parse(raw); } catch { input = null; }
  const cmd = input && typeof input === 'object' && input.tool_input && typeof input.tool_input === 'object'
    ? input.tool_input.command : undefined;
  if (typeof cmd !== 'string') {
    if (mentions(raw)) block('guard: could not read the hook input, blocking');
    allow();
  }
  if (!mentions(cmd) && !/\.githooks/i.test(cmd)) allow(); // R15 fast path
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  let branchName;
  const branch = () => {
    if (branchName === undefined) branchName = currentBranch(cwd);
    return branchName;
  };
  const c = classifyCommand(cmd, { branch });
  if (c.action === 'allow') allow();
  if (c.action === 'deny') block(`guard: ${c.reason}`);
  if (c.action !== 'push') block('guard: unexpected classification, blocking');
  await pushFlow(cwd, c.branch);
  block('guard: push flow ended unexpectedly, blocking');
}

function crash() {
  say(2, 'guard: internal error in the Claude Code hook, blocking');
  process.exit(2);
}

const invoked = (() => { try { return fs.realpathSync(process.argv[1]); } catch { return null; } })();
if (invoked === fs.realpathSync(fileURLToPath(import.meta.url))) {
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);
  try { main().catch(crash); } catch { crash(); }
}
