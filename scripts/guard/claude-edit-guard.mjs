// Claude Code PreToolUse hook for Edit|Write|MultiEdit|NotebookEdit (layer 3, ruling R21).
// An edit to the guard's own files (git hooks, guard scripts, setup, Claude settings, CI
// workflows, .git, CONTENT-GUIDELINES.md, the gitleaks config) gets permissionDecision "ask",
// so a human approves each one. Every other path exits 0 with no output. Paths are resolved (`..`, symlinks, case) before matching.
// Any error exits 2 when the input looks like it names a guard file, else 0.
import fs from 'node:fs';
import path from 'node:path';

const GUARDED = [/^\.githooks(\/|$)/, /^scripts\/guard(\/|$)/, /^scripts\/setup\.sh$/, /^\.claude\/settings[^/]*\.json$/,
  /^\.github\/workflows(\/|$)/, /^\.git(\/|$)/,
  // the rules the AI review applies, and the secret scanner's config and allowlist
  /^content-guidelines\.md$/, /^\.gitleaks\.toml$/, /^\.gitleaksignore$/];
// Kept in step with the case pattern in the .claude/settings.json command.
const LOOKS_GUARDED = /git|guard|setup|settings|guidelines/i;
const REASON = 'this file is part of the commit/push guard; Hedayat must approve changes to it';

// Real path of p, even when p (or its last parts) does not exist yet.
function realish(p) {
  let head = p;
  const tail = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(head), ...tail); } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
    }
    const up = path.dirname(head);
    if (up === head) return p;
    tail.unshift(path.basename(head));
    head = up;
  }
}

// True when abs, as written or with symlinks resolved, lies under a guarded path of the project
// (as written or resolved). Compared lowercased: the Mac file system ignores case.
function guarded(abs, project) {
  const roots = [path.resolve(project), realish(path.resolve(project))].map((r) => r.toLowerCase());
  for (const candidate of [abs, realish(abs)]) {
    for (const root of roots) {
      const rel = path.relative(root, candidate.toLowerCase());
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      if (GUARDED.some((re) => re.test(rel.split(path.sep).join('/')))) return true;
    }
  }
  return false;
}

function main(raw) {
  const input = JSON.parse(raw);
  const ti = input && typeof input === 'object' ? input.tool_input : null;
  if (!ti || typeof ti !== 'object') throw new Error('no tool_input');
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const project = process.env.CLAUDE_PROJECT_DIR || cwd;
  const files = [ti.file_path, ti.notebook_path].filter((f) => f !== undefined);
  if (files.length === 0 || files.some((f) => typeof f !== 'string' || f === '')) throw new Error('no file path');
  if (files.some((f) => guarded(path.resolve(cwd, f), project))) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `guard: ${REASON}`,
    } }));
  }
}

let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch { raw = ''; }
try {
  main(raw);
  process.exit(0);
} catch {
  if (LOOKS_GUARDED.test(raw)) {
    process.stderr.write('guard: could not check this edit against the guard file list, blocking\n');
    process.exit(2);
  }
  process.exit(0);
}
