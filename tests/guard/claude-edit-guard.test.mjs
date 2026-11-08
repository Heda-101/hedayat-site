import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GUARD = path.join(ROOT, 'scripts/guard/claude-edit-guard.mjs');
const MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';

const dirs = [];
function tmp(prefix) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// A project with the guarded folders, so symlink and `..` cases have something to resolve to.
// Its name avoids the words the no-Node fallback looks for (git, guard, setup, settings).
function project() {
  const p = tmp('site-edit-');
  for (const d of ['.githooks', 'scripts/guard', '.claude', '.github/workflows', '.git', 'src']) fs.mkdirSync(path.join(p, d), { recursive: true });
  fs.writeFileSync(path.join(p, 'scripts/guard/check.mjs'), '// x\n');
  fs.writeFileSync(path.join(p, 'src/page.astro'), '---\n---\n');
  return p;
}

const input = (tool, file, cwd, key = 'file_path') => ({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { [key]: file }, cwd });

function run(proj, data, env = {}) {
  const r = spawnSync(process.execPath, [GUARD], {
    input: typeof data === 'string' ? data : JSON.stringify(data), encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, ...env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function asks(r) {
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /guard/);
}
const passes = (r) => { assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), ''); };

test('I4: edits to guard files ask for approval', () => {
  const p = project();
  for (const f of ['.githooks/pre-push', 'scripts/guard/check.mjs', 'scripts/guard/new.mjs', 'scripts/setup.sh',
    '.claude/settings.json', '.claude/settings.local.json', '.github/workflows/guard.yml', '.git/config', '.git/hooks/pre-commit']) {
    for (const tool of ['Edit', 'Write', 'MultiEdit']) asks(run(p, input(tool, path.join(p, f), p)));
  }
  asks(run(p, input('NotebookEdit', path.join(p, 'scripts/guard/n.ipynb'), p, 'notebook_path')));
  asks(run(p, input('Write', 'scripts/guard/rel.mjs', p)));
});

test('F3: the content rules and gitleaks config ask for approval too', () => {
  const p = project();
  for (const f of ['CONTENT-GUIDELINES.md', 'content-guidelines.md', '.gitleaks.toml', '.gitleaksignore']) {
    for (const tool of ['Edit', 'Write', 'MultiEdit']) asks(run(p, input(tool, path.join(p, f), p)));
  }
  asks(run(p, input('Write', 'CONTENT-GUIDELINES.md', p)));
  // only the root copies are guard files
  for (const f of ['docs/CONTENT-GUIDELINES.md', 'src/.gitleaks.toml', 'CONTENT-GUIDELINES.md.bak']) passes(run(p, input('Edit', path.join(p, f), p)));
});

test('F3 settings: without Node 22, an edit to the content rules blocks', () => {
  const p = project();
  const env = { PATH: '/usr/bin:/bin', NVM_DIR: '/nonexistent', HOME: tmp('guard-home-') };
  assert.equal(viaSettings(p, input('Edit', path.join(p, 'CONTENT-GUIDELINES.md'), p), env).status, 2);
  assert.equal(viaSettings(p, input('Edit', path.join(p, '.gitleaks.toml'), p), env).status, 2);
  asks(viaSettings(p, input('Edit', path.join(p, 'CONTENT-GUIDELINES.md'), p)));
});

test('I4: other paths pass silently', () => {
  const p = project();
  for (const f of ['src/page.astro', 'README.md', 'scripts/build.sh', '.claude/agents/x.md', '.github/ISSUE_TEMPLATE/a.md',
    'tests/guard/x.test.mjs', 'docs/setup.md', '.gitignore']) {
    passes(run(p, input('Edit', path.join(p, f), p)));
  }
  passes(run(p, input('Write', '/tmp/elsewhere/scripts/guard/x.mjs', p)));
});

test('I4: `..`, case and symlinks are resolved before matching', () => {
  const p = project();
  asks(run(p, input('Edit', path.join(p, 'src/../scripts/guard/check.mjs'), p)));
  asks(run(p, input('Edit', path.join(p, 'Scripts/Guard/check.mjs'), p)));
  asks(run(p, input('Edit', path.join(p, '.GitHooks/pre-commit'), p)));
  fs.symlinkSync(path.join(p, 'scripts/guard'), path.join(p, 'src/g'));
  asks(run(p, input('Edit', path.join(p, 'src/g/check.mjs'), p)));
  asks(run(p, input('Write', path.join(p, 'src/g/brand-new.mjs'), p)));
  fs.symlinkSync(path.join(p, 'scripts/guard/check.mjs'), path.join(p, 'src/link.mjs'));
  asks(run(p, input('Edit', path.join(p, 'src/link.mjs'), p)));
  const outside = tmp('site-out-');
  fs.symlinkSync(path.join(p, '.githooks'), path.join(outside, 'h'));
  asks(run(p, input('Write', path.join(outside, 'h/pre-push'), outside)));
});

test('I4: errors exit 2 only for guarded-looking input', () => {
  const p = project();
  assert.equal(run(p, 'not json').status, 0);
  assert.equal(run(p, '').status, 0);
  assert.equal(run(p, '{"tool_input": {"file_path": "scripts/guard/x').status, 2);
  assert.equal(run(p, JSON.stringify({ tool_input: { file_path: 42 }, note: '.githooks' })).status, 2);
  assert.equal(run(p, JSON.stringify({ tool_input: { file_path: 42 } })).status, 0);
});

// ---------- settings.json wiring ----------

function settingsEntry() {
  const s = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude/settings.json'), 'utf8'));
  const e = s.hooks.PreToolUse.find((x) => x.matcher === MATCHER);
  assert.ok(e, 'Edit/Write matcher missing');
  assert.equal(e.hooks[0].type, 'command');
  return e.hooks[0].command;
}

function viaSettings(proj, data, env = {}) {
  // The command runs the guard from CLAUDE_PROJECT_DIR, so the temp project gets this repo's guard scripts.
  fs.mkdirSync(path.join(proj, 'scripts/guard'), { recursive: true });
  for (const f of ['node22.sh', 'claude-edit-guard.mjs']) fs.copyFileSync(path.join(ROOT, 'scripts/guard', f), path.join(proj, 'scripts/guard', f));
  const r = spawnSync('/bin/sh', ['-c', settingsEntry()], {
    input: JSON.stringify(data), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: proj, ...env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('I4 settings: the matcher asks for guard files and passes others', () => {
  const syn = spawnSync('bash', ['-n', '-c', settingsEntry()], { encoding: 'utf8' });
  assert.equal(syn.status, 0, syn.stderr);
  const p = project();
  asks(viaSettings(p, input('Edit', path.join(p, 'scripts/guard/check.mjs'), p)));
  passes(viaSettings(p, input('Edit', path.join(p, 'src/page.astro'), p)));
});

test('I4 settings: without Node 22, guard-looking paths block and others pass', () => {
  const p = project();
  const env = { PATH: '/usr/bin:/bin', NVM_DIR: '/nonexistent', HOME: tmp('guard-home-') };
  assert.equal(viaSettings(p, input('Edit', path.join(p, 'scripts/guard/check.mjs'), p), env).status, 2);
  assert.equal(viaSettings(p, input('Edit', path.join(p, 'src/page.astro'), p), env).status, 0);
});
