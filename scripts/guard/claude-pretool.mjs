// Claude Code PreToolUse hook for Bash (layer 3 of the commit/push guard).
// Denies attempts to bypass the git hooks; on an agent `git push` it re-runs the
// deterministic push checks. The AI confidentiality review runs in the pre-push hook,
// which every agent push reaches (R18a, R22).
// Exit 0 = allow, exit 2 = block (reason on stderr). Exit 1 is never used: Claude Code
// treats it as non-blocking, so every error on a git-related command becomes exit 2.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
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
// Also drop brace/bracket glob syntax, so `.gi{t,x}hooks` or `.[g]ithooks` still reads as git.
export const mentions = (s) => mentionsRaw(s) || mentionsRaw(dequote(s)) || mentionsRaw(s.replace(/['"\\{}[\],]/g, ''));

// ---------- .githooks matching (literal, glob or brace) ----------

function expandBraces(str, cap = 64) {
  const m = /\{([^{}]*,[^{}]*)\}/.exec(str);
  if (!m) return [str];
  const res = [];
  for (const alt of m[1].split(',')) {
    for (const e of expandBraces(str.slice(0, m.index) + alt + str.slice(m.index + m[0].length), cap)) {
      res.push(e);
      if (res.length >= cap) return res;
    }
  }
  return res;
}

function globToRe(seg) {
  let re = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const j = seg.indexOf(']', i + 2);
      if (j === -1) { re += '\\['; continue; }
      let body = seg.slice(i + 1, j);
      if (body[0] === '!' || body[0] === '^') body = `^${body.slice(1)}`;
      re += `[${body.replace(/\\/g, '\\\\')}]`;
      i = j;
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

// namesHooksDir over each shell word of a whole command string.
export function wordsNameHooksDir(cmd) {
  return cmd.split(/[\s;|&()<>]+/).some((w) => w && namesHooksDir(w));
}

// True when a word names .githooks literally, or could expand to it via a glob or braces.
export function namesHooksDir(v) {
  const d = dequote(v);
  if (/\.githooks/i.test(d)) return true;
  if (!/[*?[{]/.test(d)) return false;
  for (const e of expandBraces(d)) {
    if (/\.githooks/i.test(e)) return true;
    for (const seg of e.split('/')) {
      // shell globs never match a leading dot implicitly, so only dot-led segments can reach .githooks
      if (seg[0] !== '.' || !/[*?[]/.test(seg)) continue;
      try { if (globToRe(seg).test('.githooks')) return true; } catch { return true; }
    }
  }
  return false;
}

const deny = (reason) => ({ action: 'deny', reason });
const ALLOW = Object.freeze({ action: 'allow' });

// ---------- lexer ----------
// Splits a bash command into parts (on newlines ; & | ( ) and their doubles) and words,
// honouring quotes, escapes, $(...), backticks, <(...), heredocs and comments.
// Command substitutions are lexed recursively and recorded in `substs`.

function lex(src, start = 0, depth = 0, out = { substs: [] }) {
  const parts = [];
  let part = { toks: [], redirOut: false, heredocs: [] };
  let cur = null; // { v, dyn }
  let pendingHeredocs = [];
  let redirOp = null; // the next word is the target of this redirect operator
  let i = start;

  const word = () => {
    if (!cur) { cur = { v: '', dyn: false }; if (redirOp) { cur.redir = redirOp; redirOp = null; } }
    return cur;
  };
  const endTok = () => { if (cur) { part.toks.push(cur); cur = null; } };
  const endPart = () => {
    endTok(); redirOp = null;
    if (part.toks.length) parts.push(part);
    part = { toks: [], redirOut: false, heredocs: [] };
  };

  function subst(open) {
    // open is the index of the first char after `$(`, `<(` or `>(`
    const inner = lex(src, open, depth + 1, out);
    if (inner.error) return inner;
    const w = word();
    out.substs.push({ text: src.slice(open, inner.end), parts: inner.parts, src, raw: src.slice(open - 2, inner.end + 1),
      start: open - 2, end: inner.end + 1, dollar: src[open - 2] === '$', tok: w });
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
    out.substs.push({ text: body, parts: inner.parts, backtick: true });
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
      h.body = body;
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
    if (c === '|') {
      endPart();
      if (src[i + 1] === '|') { i += 2; continue; }
      part.pipedIn = true; // the next part reads this pipe
      i++;
      if (src[i] === '&') i++;
      continue;
    }
    if (c === ';' || c === '(') { endPart(); i++; continue; }
    if (c === '&') {
      if (src[i + 1] === '>') {
        endTok(); part.redirOut = true;
        const from = i; i += 2; if (src[i] === '>') i++;
        redirOp = src.slice(from, i); continue;
      }
      endPart(); i++; continue;
    }
    if (c === '<' || c === '>') {
      // a bare fd number right before the operator (2>&1) is not a word
      if (cur && /^\d+$/.test(cur.v) && !cur.dyn) cur = null;
      endTok();
      if (c === '>') part.redirOut = true;
      if (c === '<') part.stdinIn = true;
      let j = i + 1;
      if (c === '<' && src[j] === '<' && src[j + 1] !== '<') {
        // heredoc
        j++;
        let strip = false;
        if (src[j] === '-') { strip = true; j++; }
        while (src[j] === ' ' || src[j] === '\t') j++;
        let delim = '';
        while (j < src.length && !' \t\n;&|<>()'.includes(src[j])) delim += src[j++];
        const quoted = delim !== dequote(delim);
        delim = dequote(delim);
        if (!delim) return { error: true };
        const h = { delim, strip, quoted, body: '' };
        pendingHeredocs.push(h);
        part.heredocs.push(h);
        i = j; continue;
      }
      while (j < src.length && (src[j] === '<' || src[j] === '>')) j++;
      if (src[j] === '&' || src[j] === '|') j++;
      redirOp = src.slice(i, j);
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
  'su', 'sudo', 'doas', 'watch', 'script', 'expect', 'awk', 'gawk', 'find', 'fd', 'trap', 'exec', 'alias',
  'flock', 'caffeinate', 'setsid', 'chroot', 'ionice', 'taskset', 'unbuffer', 'chronic', 'strace', 'ltrace', 'dtruss',
  'arch', 'xcrun', 'npx', 'bunx', 'pnpx', 'tmux', 'screen', 'ssh']);
const READONLY_CMDS = new Set(['cat', 'ls', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'wc', 'file',
  'stat', 'diff', 'bat', 'shellcheck', 'shasum', 'md5', 'od', 'xxd', 'hexdump', 'test', '[']);
// Commands that never execute their arguments: a `git` argument to these is data.
const DATA_CMDS = new Set(['cat', 'grep', 'egrep', 'fgrep', 'rg', 'ls', 'echo', 'printf', 'head', 'tail', 'wc', 'sed',
  'less', 'more', 'file', 'stat', 'diff', 'bat', 'jq', 'which', 'type', 'whereis', 'man', 'cd', 'pushd', 'popd',
  'sort', 'uniq', 'cut', 'tr', 'column', 'nl', 'comm']);
// sort runs --compress-program on its temp files, so that option makes it an executor.
const sortIsData = (args) => !args.some((t) => t.dyn || /^--com/.test(dequote(t.v)));

// sed counts as data only when no script uses the e (execute) or w/W (write) commands or flags.
function sedIsData(args) {
  const scripts = [];
  let saw = false;
  for (let k = 0; k < args.length; k++) {
    const v = args[k].v;
    if (args[k].dyn) return false;
    if (v === '--expression' || /^-[A-Za-z]*e$/.test(v)) { scripts.push(args[k + 1] ? args[k + 1].v : ''); k++; saw = true; continue; }
    if (v.startsWith('--expression=')) { scripts.push(v.slice(13)); saw = true; continue; }
    if (v.startsWith('--file') || /^-[A-Za-z]*f/.test(v)) return false;
    if (v.startsWith('-')) continue;
    if (!saw) { scripts.push(v); saw = true; }
  }
  for (const sc of scripts) {
    const stripped = sc
      .replace(/s(.)(?:\\.|(?!\1)[^\\])*\1(?:\\.|(?!\1)[^\\])*\1/g, 's')
      .replace(/\/(?:\\.|[^/\\])*\//g, '');
    if (/[ewW]/.test(stripped)) return false;
  }
  return true;
}

// Tokens that are message values: git commit|tag|merge -m/--message/-F/--file <v>,
// gh pr|issue create|edit --body/--title/-b/-t <v> (or the --opt=<v> forms).
const GIT_MSG_SUBS = new Set(['commit', 'tag', 'merge']);
const GIT_MSG_OPTS = ['-m', '--message', '-F', '--file'];
const GH_MSG_OPTS = ['--body', '--title', '-b', '-t'];
function messageSlots(toks) {
  const out = [];
  const u = unwrap(toks);
  if (u.nested || u.where) return out;
  const t = u.toks;
  if (!t.length || t[0].dyn) return out;
  const b = base(t[0].v);
  let i;
  let opts;
  if (b === 'git') {
    i = 1;
    while (t[i] && !t[i].dyn && t[i].v.startsWith('-')) i += (t[i].v === '-C' || t[i].v === '-c') ? 2 : 1;
    if (!t[i] || t[i].dyn || !GIT_MSG_SUBS.has(t[i].v)) return out;
    opts = GIT_MSG_OPTS; i++;
  } else if (b === 'gh') {
    if (!t[1] || !t[2] || t[1].dyn || t[2].dyn || !['pr', 'issue'].includes(t[1].v) || !['create', 'edit'].includes(t[2].v)) return out;
    opts = GH_MSG_OPTS; i = 3;
  } else return out;
  for (let k = i; k < t.length; k++) {
    if (k > i && opts.includes(t[k - 1].v)) out.push({ tok: t[k], prefix: '' });
    for (const o of opts) if (o.startsWith('--') && t[k].v.startsWith(`${o}=`)) out.push({ tok: t[k], prefix: `${o}=` });
  }
  return out;
}

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
  if (ctx.gitSubs) ctx.gitSubs.push(sub);
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
  if (rest.some((t) => namesHooksDir(t.v)) && !GIT_READONLY.has(sub)) {
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
    // Output redirects that only merge or drop messages (2>&1, 2>/dev/null) are fine; nothing else.
    const okRedir = (t) => (t.redir === '>&' && t.v === '1') || (t.redir === '>' && t.v === '/dev/null');
    if (rest.some((t) => t.redir && !okRedir(t))) return deny(PUSH_ONLY);
    const args = rest.filter((t) => !t.redir);
    if (args.some((t) => t.dyn || /[{}$*?[\]~\\^:@]/.test(t.v))) return deny(PUSH_ONLY);
    const v = args.map((t) => (t.v === '--set-upstream' ? '-u' : t.v));
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
  const anyHooksDir = toks.some((t) => namesHooksDir(t.v));
  if (b === 'git') {
    if (nested) return deny(NESTED);
    if (part.redirOut && anyHooksDir) return deny('agents may only read .githooks');
    return classifyGit(toks.slice(1), ctx);
  }
  if (INTERPRETERS.has(b) && ctx.mentioned) return deny(NESTED);
  if (toks.some((t) => t.ansi) && ctx.mentioned) return deny(NESTED);
  const isData = DATA_CMDS.has(b) && (b !== 'sed' || sedIsData(toks.slice(1))) && (b !== 'sort' || sortIsData(toks.slice(1)));
  // An unknown command that reads a pipe, a redirect or a heredoc, or that is handed an
  // interpreter name, may be executing that input: not allowed alongside git.
  if (ctx.mentioned && !isData) {
    if (part.pipedIn || part.stdinIn || (part.heredocs && part.heredocs.length)) return deny(NESTED);
    if (toks.slice(1).some((t) => INTERPRETERS.has(base(dequote(t.v))))) return deny(NESTED);
  }
  if (!isData) {
    const slots = new Set(messageSlots(part.toks).map((x) => x.tok));
    for (const t of toks.slice(1)) {
      if (slots.has(t)) continue;
      const v = dequote(t.v);
      if (base(v) === 'git' || /\bgit\b/i.test(v)) return deny(NESTED);
      if (t.dyn && ctx.mentioned) return deny('shell expansions alongside git are not allowed for agents');
    }
  }
  if (anyHooksDir && (!READONLY_CMDS.has(b) || part.redirOut)) return deny('agents may only read .githooks');
  return ALLOW;
}

// A `$(...)` whose only part is a bare `cat` reading one heredoc that cannot expand anything.
function isDataHeredoc(x, cmd) {
  if (x.backtick || !x.dollar || x.src !== cmd || x.parts.length !== 1) return false;
  const p = x.parts[0];
  if (p.redirOut || p.toks.length !== 1 || p.toks[0].dyn || p.toks[0].v !== 'cat' || p.heredocs.length !== 1) return false;
  const h = p.heredocs[0];
  return h.quoted || !/[$`\\]/.test(h.body);
}

// classifyCommand(cmd, { branch }) -> allow | deny(reason) | push(remote, branch).
// `branch` is the current branch name, null for a detached HEAD, or a function returning either.
export function classifyCommand(cmd, opts = {}) {
  if (typeof cmd !== 'string') return deny(UNPARSABLE);
  if (!mentions(cmd) && !wordsNameHooksDir(cmd)) return ALLOW;
  const lexed = lex(cmd);
  if (lexed.error) return globalChecks(cmd) || deny(UNPARSABLE);
  // `$(cat <<'EOF' … EOF)` is data (a commit or PR message): leave its body out of every check.
  const candidates = lexed.substs.filter((x) => isDataHeredoc(x, cmd));
  const slotToks = lexed.parts.flatMap((p) => messageSlots(p.toks));
  // bound by identity: the slot word must be exactly this substitution (plus an --opt= prefix)
  const data = candidates.filter((x) => slotToks.some((sl) => sl.tok === x.tok && sl.tok.v === `${sl.prefix}${x.raw}`));
  let text = cmd;
  for (const x of [...data].sort((a, b) => b.start - a.start)) text = text.slice(0, x.start) + ' '.repeat(x.end - x.start) + text.slice(x.end);
  if (data.length) {
    for (const p of lexed.parts) for (const t of p.toks) for (const x of data) t.v = t.v.split(x.raw).join('');
  }
  // The interpreter, dynamic-name and expansion rules see the full text, data bodies included.
  const mentioned = mentions(cmd);
  const g = globalChecks(text);
  if (g) return g;
  let cachedBranch;
  const ctx = {
    mentioned,
    branch: () => {
      if (cachedBranch === undefined) cachedBranch = typeof opts.branch === 'function' ? opts.branch() : (opts.branch ?? null);
      return cachedBranch;
    },
    hasCd: false,
    gitSubs: Array.isArray(opts.gitSubs) ? opts.gitSubs : null,
  };
  const all = lexed.parts.map((p) => ({ p, nested: false }));
  for (const s of lexed.substs) {
    if (data.includes(s)) continue;
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

// ---------- I5: PR and issue text ----------
// gh pr|issue text options get the same blocked-term scan as commits (spec §5).
const GH_TEXT_SUBS = { pr: ['create', 'edit', 'comment', 'review', 'merge'], issue: ['create', 'edit', 'comment'] };
const GH_TEXT_OPTS = { '--title': '--title', '-t': '--title', '--body': '--body', '-b': '--body',
  '--body-file': '--body-file', '-F': '--body-file', '--subject': '--subject' };
export const mentionsGh = (s) => /\bgh\b/i.test(s);

// Returns null when no gh pr|issue text command is present, else { error } or
// { items: [{ opt, text } | { opt, file }] } with opt as its long name.
export function ghTextItems(cmd) {
  const lexed = lex(cmd);
  if (lexed.error) return { error: UNPARSABLE };
  const parts = [...lexed.parts, ...lexed.substs.flatMap((x) => x.parts)];
  const items = [];
  let found = false;
  for (const p of parts) {
    const t = unwrap(p.toks).toks;
    if (!t.length || t[0].dyn || base(t[0].v).toLowerCase() !== 'gh') continue;
    if ((t[1] && t[1].dyn) || (t[2] && t[2].dyn)) return { error: 'gh commands with shell expansions in the command name are not allowed for agents' };
    const subs = t[1] && GH_TEXT_SUBS[t[1].v];
    if (!subs || !t[2] || !subs.includes(t[2].v)) continue;
    found = true;
    for (let k = 3; k < t.length; k++) {
      const tok = t[k];
      let opt;
      let val;
      let prefix = '';
      if (!tok.dyn && Object.hasOwn(GH_TEXT_OPTS, tok.v)) {
        opt = GH_TEXT_OPTS[tok.v];
        val = t[++k];
        if (!val) break;
      } else {
        const m = /^(--title|--body-file|--body|--subject)=/.exec(tok.v) || /^-[tbF](?=.)/.exec(tok.v);
        if (!m) continue;
        opt = GH_TEXT_OPTS[m[1] || m[0]];
        prefix = m[0];
        val = tok;
      }
      const data = lexed.substs.find((x) => x.tok === val && val.v === `${prefix}${x.raw}` && isDataHeredoc(x, cmd));
      let text;
      if (data) text = data.parts[0].heredocs[0].body;
      else if (val.dyn) return { error: `cannot check ${opt} built from shell expansions; use literal text, a quoted heredoc or --body-file` };
      else text = val.v.slice(prefix.length);
      items.push(opt === '--body-file' ? { opt, file: text } : { opt, text });
    }
  }
  return found ? { items } : null;
}

// Blocks (exit 2) on any blocked term in the gh text, on a missing terms file, or on a file
// that cannot be read. Output names only the option, never the text.
async function scanGhText(items, cwd) {
  const { loadGuardTerms } = await import('./check.mjs');
  const { findTerms } = await import('./terms.mjs');
  let terms;
  try { terms = loadGuardTerms(); } catch (e) { block(`guard: ${e.message}`); }
  const lines = [];
  for (const it of items) {
    let text = it.text;
    if (it.file !== undefined) {
      if (it.file === '-' || it.file === '') block('guard: cannot check --body-file from stdin; write the text to a file first');
      try { text = fs.readFileSync(path.resolve(cwd, it.file), 'utf8'); }
      catch { block('guard: could not read the --body-file to check it, blocking'); }
    }
    for (const n of new Set(findTerms(text, terms).map((h) => h.termIndex))) lines.push(`guard: blocked-term #${n} in ${it.opt}`);
  }
  if (lines.length) block([...lines, 'guard: PR and issue text follows the same rules as commits']);
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

async function pushFlow(cwd, branch) {
  const { git } = await import('./scope.mjs');
  const { runPushChecks, loadGuardTerms } = await import('./check.mjs');
  const { findTerms, clean } = await import('./terms.mjs');

  let terms;
  try { terms = loadGuardTerms(); } catch (e) { block(`guard: ${e.message}`); }
  const mask = (s) => (findTerms(s, terms).length ? '[withheld]' : s);

  const localSha = git(['rev-parse', '--verify', 'HEAD^{commit}'], cwd).trim();
  // No remote sha here: a local origin/<branch> can be stale (deleted on the server), so the
  // checks cover every commit not on origin's live branch and tag tips (git ls-remote).
  const ref = `refs/heads/${branch}`;
  const refs = [{ localRef: ref, localSha, remoteRef: ref, remoteSha: Z, remote: 'origin' }];

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

  // The AI review follows in the pre-push hook of the push itself (R18a, R22).
  say(1, 'guard: push checks passed; the AI review runs in pre-push');
  allow();
}

const INTEGRITY = 'guard hooks are missing or disabled; Hedayat must restore them (bash scripts/setup.sh)';
const STATE_CHANGING = new Set(['commit', 'push', 'merge', 'rebase', 'cherry-pick', 'tag', 'reset', 'checkout', 'switch',
  'restore', 'am', 'apply', 'revert', 'pull']);

// R18b: the repo's guard is intact: core.hooksPath=.githooks, the three hooks are regular
// executable files (not symlinks), and scripts/guard/check.mjs exists. Any error = not intact.
export function hooksIntact(cwd) {
  try {
    const run = (args, dir) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const top = run(['rev-parse', '--show-toplevel'], cwd);
    if (run(['config', '--get', 'core.hooksPath'], top) !== '.githooks') return false;
    for (const h of ['pre-commit', 'commit-msg', 'pre-push']) {
      const f = path.join(top, '.githooks', h);
      if (!fs.lstatSync(f).isFile()) return false;
      fs.accessSync(f, fs.constants.X_OK);
    }
    return fs.lstatSync(path.join(top, 'scripts/guard/check.mjs')).isFile();
  } catch {
    return false;
  }
}

const SELF = fileURLToPath(import.meta.url);
const DEADLINE_MS = 480_000;

// The push checks run in a child process so that a hard deadline can fire even while
// gitleaks or git block that process synchronously. The deadline can only be shortened.
function deadlineMs() {
  const v = Number(process.env.GUARD_HOOK_DEADLINE_MS);
  return Number.isFinite(v) && v > 0 ? Math.min(v, DEADLINE_MS) : DEADLINE_MS;
}

function runPushWorker(cwd, branch) {
  return new Promise(() => {
    const ms = deadlineMs();
    const child = spawn(process.execPath, [SELF, '--push-worker', cwd, branch], {
      stdio: ['ignore', 'inherit', 'inherit'], detached: true,
    });
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      block(`guard: push checks hit the ${Math.round(ms / 1000)} s hook deadline, blocking`);
    }, ms);
    child.on('error', () => { clearTimeout(timer); block('guard: could not start the push checks, blocking'); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) allow();
      block(code === 2 ? [] : 'guard: push checks ended unexpectedly, blocking');
    });
  });
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
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  if (mentionsGh(cmd)) {
    const g = ghTextItems(cmd);
    if (g && g.error) block(`guard: ${g.error}`);
    if (g) await scanGhText(g.items, cwd);
  }
  if (!mentions(cmd) && !wordsNameHooksDir(cmd)) allow(); // R15 fast path
  let branchName;
  const branch = () => {
    if (branchName === undefined) branchName = currentBranch(cwd);
    return branchName;
  };
  const gitSubs = [];
  const c = classifyCommand(cmd, { branch, gitSubs });
  if (c.action === 'deny') block(`guard: ${c.reason}`);
  if ((c.action === 'push' || gitSubs.some((sub) => STATE_CHANGING.has(sub))) && !hooksIntact(cwd)) block(`guard: ${INTEGRITY}`);
  if (c.action === 'allow') allow();
  if (c.action !== 'push') block('guard: unexpected classification, blocking');
  await runPushWorker(cwd, c.branch);
  block('guard: push flow ended unexpectedly, blocking');
}

function crash() {
  say(2, 'guard: internal error in the Claude Code hook, blocking');
  process.exit(2);
}

const invoked = (() => { try { return fs.realpathSync(process.argv[1]); } catch { return null; } })();
if (invoked === fs.realpathSync(SELF)) {
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);
  const worker = process.argv[2] === '--push-worker';
  try {
    (worker ? pushFlow(process.argv[3], process.argv[4]).then(() => block('guard: push flow ended unexpectedly, blocking'))
      : main()).catch(crash);
  } catch { crash(); }
}
