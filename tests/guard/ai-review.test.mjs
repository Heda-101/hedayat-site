import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_DIFF_BYTES, buildPrompt, parseVerdict, reviewDiff, loadGuidelines } from '../../scripts/guard/ai-review.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fake = (n) => path.join(FIX, `fake-claude-${n}.sh`);
const env = (r) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: r });

async function withCmd(cmd, fn) {
  const old = process.env.GUARD_AI_CMD;
  process.env.GUARD_AI_CMD = cmd;
  try { return await fn(); } finally {
    if (old === undefined) delete process.env.GUARD_AI_CMD; else process.env.GUARD_AI_CMD = old;
  }
}
const code = (c) => (e) => e.code === c;

test('parseVerdict reads the result field, with or without a code fence', () => {
  assert.equal(parseVerdict(env('{"verdict":"pass","findings":[]}')).verdict, 'pass');
  assert.equal(parseVerdict(env('```json\n{"verdict":"block","findings":[{"file":"a","line":1,"reason":"r"}]}\n```')).findings.length, 1);
});

test('parseVerdict throws AI_UNPARSABLE on prose, unknown verdict or bad envelope', () => {
  assert.throws(() => parseVerdict('not json'), code('AI_UNPARSABLE'));
  assert.throws(() => parseVerdict(env('Looks fine to me.')), code('AI_UNPARSABLE'));
  assert.throws(() => parseVerdict(env('{"verdict":"maybe","findings":[]}')), code('AI_UNPARSABLE'));
  assert.throws(() => parseVerdict(env('{"findings":[]}')), code('AI_UNPARSABLE'));
  assert.throws(() => parseVerdict(env('{"verdict":"block","findings":[{"file":1}]}')), code('AI_UNPARSABLE'));
  assert.throws(() => parseVerdict(JSON.stringify({ type: 'result' })), code('AI_UNPARSABLE'));
});

test('parseVerdict treats an error envelope as AI_FAILED', () => {
  const bad = JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: '{"verdict":"pass","findings":[]}' });
  assert.throws(() => parseVerdict(bad), code('AI_FAILED'));
  const bad2 = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: false, result: '{"verdict":"pass","findings":[]}' });
  assert.throws(() => parseVerdict(bad2), code('AI_FAILED'));
});

test('buildPrompt includes guidelines, binary paths and diff', () => {
  const p = buildPrompt('RULE-ONE', '+hello world', ['img/a.png', 'img/b.jpg']);
  assert.ok(p.includes('RULE-ONE'));
  assert.ok(p.includes('Reply with JSON only'));
  assert.ok(p.includes('- img/a.png') && p.includes('- img/b.jpg'));
  assert.ok(p.includes('```diff\n+hello world\n```') || p.includes('+hello world'));
  assert.ok(p.indexOf('RULE-ONE') < p.indexOf('Review the diff below'));
  assert.ok(p.indexOf('img/a.png') < p.indexOf('+hello world'));
});

test('buildPrompt fence survives a diff containing backticks', () => {
  const p = buildPrompt('G', '+```\n+x', []);
  assert.ok(p.includes('````'));
});

test('loadGuidelines reads the file and fails closed when missing or empty', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-'));
  try {
    assert.throws(() => loadGuidelines(d), code('AI_NO_GUIDELINES'));
    fs.writeFileSync(path.join(d, 'CONTENT-GUIDELINES.md'), '  \n');
    assert.throws(() => loadGuidelines(d), code('AI_NO_GUIDELINES'));
    fs.writeFileSync(path.join(d, 'CONTENT-GUIDELINES.md'), 'be kind\n');
    assert.equal(loadGuidelines(d).trim(), 'be kind');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('reviewDiff blocks diffs over 200000 bytes without calling the model', async () => {
  assert.equal(MAX_DIFF_BYTES, 200_000);
  await withCmd(fake('fail'), async () => {
    await assert.rejects(reviewDiff('a'.repeat(200_001), []), code('AI_TOO_LARGE'));
  });
});

test('reviewDiff: pass, block, garbage, exit 1, missing command', async () => {
  const pass = await withCmd(fake('pass'), () => reviewDiff('+x', []));
  assert.equal(pass.verdict, 'pass');
  const block = await withCmd(fake('block'), () => reviewDiff('+x', ['a.png']));
  assert.equal(block.verdict, 'block');
  assert.equal(block.findings[0].file, 'a.md');
  await withCmd(fake('garbage'), () => assert.rejects(reviewDiff('+x', []), code('AI_UNPARSABLE')));
  await withCmd(fake('fail'), () => assert.rejects(reviewDiff('+x', []), code('AI_FAILED')));
  await withCmd('/nonexistent/claude', () => assert.rejects(reviewDiff('+x', []), code('AI_FAILED')));
});

test('reviewDiff kills the child and throws AI_FAILED on timeout', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'slow-'));
  const slow = path.join(d, 'slow.sh');
  fs.writeFileSync(slow, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
  try {
    const t0 = Date.now();
    await withCmd(slow, () => assert.rejects(reviewDiff('+x', [], { timeoutMs: 300 }), code('AI_FAILED')));
    assert.ok(Date.now() - t0 < 5000);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
