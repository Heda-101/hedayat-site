import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadTerms, findTerms, GuardError, clean } from './terms.mjs';
import { newImagesInPush, confirmImages } from './images.mjs';
import { collectStaged, collectPush, collectRange, parsePushRefs, effectiveRevs, reviewBatchesForPush } from './scope.mjs';
import { reviewDiff, REVIEW_TIMEOUT_MS } from './ai-review.mjs';

const HINT = 'create ~/.config/hedayat-site/blocked-terms.txt with at least one term';

export function termsPath() {
  return process.env.GUARD_TERMS_FILE || path.join(os.homedir(), '.config', 'hedayat-site', 'blocked-terms.txt');
}

function fail(msg) {
  process.stderr.write(`guard: ${msg}\n`);
  process.exit(1);
}

// Loads the blocked terms; every failure is a GuardError whose message is safe to print.
export function loadGuardTerms() {
  try {
    return loadTerms(termsPath());
  } catch (e) {
    if (e instanceof GuardError) {
      if (e.code === 'TERMS_MISSING' || e.code === 'TERMS_EMPTY') throw new GuardError(e.code, HINT);
      throw new GuardError(e.code, `blocked-terms file is invalid: ${e.message}`);
    }
    throw new GuardError('TERMS_UNREADABLE', `could not read the blocked-terms file (${e && e.code ? e.code : 'error'})`);
  }
}

function loadOrDie() {
  try { return loadGuardTerms(); } catch (e) { fail(e.message); }
}

// Output must never contain a term, so a location that itself contains one is masked.
export function safeWhere(where, terms) {
  if (findTerms(where, terms).length === 0) return where;
  const kind = /^(path|branch|commit)\b/.exec(where);
  if (kind) return `${kind[1]} [withheld]`;
  const m = /^[\s\S]*?(:\d+(?: \(commit \w+\))?)$/.exec(where);
  return m ? `[withheld]${m[1]}` : '[withheld]';
}

const toStdout = (lines) => { for (const l of lines) process.stdout.write(`${l}\n`); };
const toStderr = (lines) => { for (const l of lines) process.stderr.write(`${l}\n`); };

// Term hits as printable lines (locations masked).
function scanLines(items, terms) {
  const out = [];
  for (const it of items) {
    for (const h of findTerms(it.text, terms)) out.push(`blocked-term #${h.termIndex} at ${safeWhere(it.where, terms)}`);
  }
  return out;
}

function scan(items, terms) {
  const lines = scanLines(items, terms);
  toStdout(lines);
  return lines.length > 0;
}

// Returns masked output lines; an empty array means gitleaks passed.
function gitleaksLines(args, terms, cwd) {
  try {
    execFileSync('gitleaks', [...args, '--redact', '--no-banner'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024,
    });
    return [];
  } catch (e) {
    if (e.code === 'ENOENT') return ['guard: gitleaks not found; install it (brew install gitleaks). Blocking.'];
    const out = [];
    for (const l of `${e.stdout || ''}${e.stderr || ''}`.split('\n')) {
      if (l.trim() === '') continue;
      out.push(findTerms(l, terms).length ? '[line withheld]' : l);
    }
    out.push('guard: gitleaks blocked this (secret found or scan failed)');
    return out;
  }
}

function runGitleaks(args, terms) {
  const lines = gitleaksLines(args, terms);
  toStderr(lines);
  return lines.length > 0;
}

// Deterministic push checks shared by the pre-push hook and the Claude Code hook.
// opts: { cwd, terms (loaded via loadGuardTerms when absent), tty (no tty = new images block) }.
// Never throws; returns { ok, lines, images } where lines are already masked.
export function runPushChecks(refs, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const lines = [];
  let images = [];
  let terms;
  try { terms = opts.terms || loadGuardTerms(); }
  catch (e) { return { ok: false, lines: [`guard: ${e.message}`], images }; }
  try {
    for (const ref of refs) {
      const range = effectiveRevs(ref, cwd);
      if (range.kind === 'delete') continue;
      lines.push(...gitleaksLines(['git', `--log-opts=${range.revs.join(' ')}`], terms, cwd));
    }
    lines.push(...scanLines(collectPush(refs, cwd), terms));
    if (lines.length > 0) return { ok: false, lines, images };
    // A term scan cannot read pictures, so a human must confirm any new image (fails closed).
    images = newImagesInPush(refs, cwd);
    if (images.length > 0) {
      for (const p of images) lines.push(`image needs confirmation: ${safeWhere(`path ${p}`, terms).replace(/^path /, '')}`);
      if (!opts.tty || !confirmImages(images, opts.tty)) return { ok: false, lines, images };
    }
    return { ok: true, lines, images };
  } catch (e) {
    lines.push(`guard: scan failed, blocking (${e && e.code ? e.code : 'error'})`);
    return { ok: false, lines, images };
  }
}

const maskWith = (terms) => (s) => (findTerms(s, terms).length ? '[withheld]' : s);

// AI findings as printable lines, with blocked terms and control characters removed.
export function formatFindings(findings, terms) {
  const mask = maskWith(terms);
  return findings.map((f) => `guard: ${mask(clean(f.file))}:${f.line}: ${mask(clean(f.reason))}`);
}

// Overall budget for every AI batch of one push, kept well inside the 600 s Bash timeout
// agents use for `git push`. GUARD_AI_DEADLINE_MS can only shorten it.
export const AI_DEADLINE_MS = 360_000;
function aiDeadlineMs() {
  const v = Number(process.env.GUARD_AI_DEADLINE_MS);
  return Number.isFinite(v) && v > 0 ? Math.min(v, AI_DEADLINE_MS) : AI_DEADLINE_MS;
}

// AI confidentiality review of a push (run after the deterministic checks pass), one model
// call per batch (R22), in order; any block or failure blocks the push.
// Never throws; returns { ok, lines } with masked lines. An empty push needs no review.
export async function agentReview(refs, terms, cwd = process.cwd()) {
  const mask = maskWith(terms);
  try {
    const batches = reviewBatchesForPush(refs, cwd);
    if (batches.length === 0) return { ok: true, lines: ['guard: nothing new for the AI review'] };
    const end = Date.now() + aiDeadlineMs();
    for (let i = 0; i < batches.length; i++) {
      const left = end - Date.now();
      if (left <= 0) throw new GuardError('AI_FAILED', 'AI review hit its overall deadline');
      const v = await reviewDiff(batches[i].diff, batches[i].binaryPaths, { timeoutMs: Math.min(REVIEW_TIMEOUT_MS, left) });
      if (v.verdict !== 'pass') {
        return { ok: false, lines: [...formatFindings(v.findings, terms),
          `guard: AI review blocked this push (batch ${i + 1} of ${batches.length})`] };
      }
    }
    const n = batches.length;
    return { ok: true, lines: [`guard: AI review passed (${n} batch${n === 1 ? '' : 'es'})`] };
  } catch (e) {
    const code = clean(e && e.code ? e.code : 'error');
    return { ok: false, lines: [`guard: AI review failed, blocking (${code}): ${mask(clean(e && e.message ? e.message : ''))}`] };
  }
}

async function main(argv) {
  const [mode, arg] = argv;
  if (!['staged', 'message', 'push', 'ci'].includes(mode)) fail('usage: check.mjs staged | message <file> | push | ci <baseSha> <headSha>');
  const terms = loadOrDie();
  let blocked = false;
  try {
    if (mode === 'staged') {
      blocked = runGitleaks(['git', '--staged', '--pre-commit'], terms);
      blocked = scan(collectStaged(), terms) || blocked;
    } else if (mode === 'message') {
      if (!arg) fail('message mode needs the commit message file');
      const text = fs.readFileSync(arg, 'utf8');
      blocked = scan([{ where: 'commit message', text }], terms);
    } else if (mode === 'ci') {
      // CI term scan of base..head (contents, paths, messages, identities). An all-zero base
      // (new branch) scans everything reachable from head. No gitleaks, images or AI review here.
      const [, base, head] = argv;
      if (!base || !head) fail('ci mode needs <baseSha> <headSha>');
      const revs = /^0+$/.test(base) ? [head] : [`${base}..${head}`];
      blocked = scan(collectRange(revs, process.cwd()), terms);
    } else {
      const refs = parsePushRefs(fs.readFileSync(0, 'utf8'));
      const r = runPushChecks(refs, { terms, tty: process.env.GUARD_TTY || '/dev/tty' });
      toStdout(r.lines);
      blocked = !r.ok;
      // R18a: a push from an agent's shell (Claude Code sets CLAUDECODE) also gets the AI review.
      if (!blocked && process.env.CLAUDECODE) {
        const ai = await agentReview(refs, terms);
        toStdout(ai.lines);
        blocked = !ai.ok;
      }
    }
  } catch (e) {
    fail(`scan failed, blocking (${e && e.code ? e.code : 'error'})`);
  }
  process.exit(blocked ? 1 : 0);
}

// Run as a CLI only (the Claude Code hook imports runPushChecks). Node resolves a symlinked
// entry point, so compare against the real path of argv[1].
const invoked = (() => { try { return pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return null; } })();
if (invoked === import.meta.url) {
  main(process.argv.slice(2)).catch(() => fail('scan failed, blocking (error)'));
}
