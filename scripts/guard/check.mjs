import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadTerms, findTerms, GuardError } from './terms.mjs';
import { collectStaged, collectPush, parsePushRefs, pushRange } from './scope.mjs';

const HINT = 'create ~/.config/hedayat-site/blocked-terms.txt with at least one term';

function termsPath() {
  return process.env.GUARD_TERMS_FILE || path.join(os.homedir(), '.config', 'hedayat-site', 'blocked-terms.txt');
}

function fail(msg) {
  process.stderr.write(`guard: ${msg}\n`);
  process.exit(1);
}

function loadOrDie() {
  try {
    return loadTerms(termsPath());
  } catch (e) {
    if (e instanceof GuardError) {
      if (e.code === 'TERMS_MISSING' || e.code === 'TERMS_EMPTY') fail(HINT);
      fail(`blocked-terms file is invalid: ${e.message}`);
    }
    fail(`could not read the blocked-terms file (${e && e.code ? e.code : 'error'})`);
  }
}

// Output must never contain a term, so a location that itself contains one is masked.
function safeWhere(where, terms) {
  if (findTerms(where, terms).length === 0) return where;
  const kind = /^(path|branch|commit)\b/.exec(where);
  if (kind) return `${kind[1]} [withheld]`;
  const m = /^[\s\S]*?(:\d+(?: \(commit \w+\))?)$/.exec(where);
  return m ? `[withheld]${m[1]}` : '[withheld]';
}

function scan(items, terms) {
  let blocked = false;
  for (const it of items) {
    for (const h of findTerms(it.text, terms)) {
      blocked = true;
      process.stdout.write(`blocked-term #${h.termIndex} at ${safeWhere(it.where, terms)}\n`);
    }
  }
  return blocked;
}

function runGitleaks(args, terms) {
  try {
    execFileSync('gitleaks', [...args, '--redact', '--no-banner'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024,
    });
    return false;
  } catch (e) {
    if (e.code === 'ENOENT') {
      process.stderr.write('guard: gitleaks not found; install it (brew install gitleaks). Blocking.\n');
      return true;
    }
    const text = `${e.stdout || ''}${e.stderr || ''}`;
    for (const l of text.split('\n')) {
      if (l.trim() === '') continue;
      process.stderr.write(`${findTerms(l, terms).length ? '[line withheld]' : l}\n`);
    }
    process.stderr.write('guard: gitleaks blocked this (secret found or scan failed)\n');
    return true;
  }
}

function main(argv) {
  const [mode, arg] = argv;
  if (!['staged', 'message', 'push'].includes(mode)) fail('usage: check.mjs staged | message <file> | push');
  const terms = loadOrDie();
  let blocked = false;
  try {
    if (mode === 'staged') {
      blocked = runGitleaks(['git', '--staged', '--pre-commit'], terms);
      blocked = scan(collectStaged(), terms) || blocked;
    } else if (mode === 'message') {
      if (!arg) fail('message mode needs the commit message file');
      const text = fs.readFileSync(arg, 'utf8').split(/\r?\n/).filter((l) => !l.startsWith('#')).join('\n');
      blocked = scan([{ where: 'commit message', text }], terms);
    } else {
      const refs = parsePushRefs(fs.readFileSync(0, 'utf8'));
      for (const ref of refs) {
        const range = pushRange(ref);
        if (range.kind === 'delete') continue;
        blocked = runGitleaks(['git', `--log-opts=${range.revs.join(' ')}`], terms) || blocked;
      }
      blocked = scan(collectPush(refs), terms) || blocked;
    }
  } catch (e) {
    fail(`scan failed, blocking (${e && e.code ? e.code : 'error'})`);
  }
  process.exit(blocked ? 1 : 0);
}

main(process.argv.slice(2));
