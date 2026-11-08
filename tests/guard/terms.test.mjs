import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadTerms, normalize, findTerms, GuardError } from '../../scripts/guard/terms.mjs';

function tmpTerms(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-terms-'));
  const file = path.join(dir, 'terms.txt');
  if (content !== null) fs.writeFileSync(file, content);
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function codeOf(fn) {
  try { fn(); } catch (e) { return e; }
  assert.fail('expected throw');
}

test('normalize: NFKC, lowercase, strip non [a-z0-9]', () => {
  assert.equal(normalize('Ｓａｍｐｌｅ-Tool 9!'), 'sampletool9');
});

test('loose match survives case, hyphen, space, NBSP and full-width', () => {
  const t = [{ index: 1, mode: 'loose', norm: normalize('Sample Tool') }];
  for (const s of ['SampleTool', 'sample-tool', 'SAMPLE TOOL', 'Sample Tool', 'Ｓａｍｐｌｅ Tool'])
    assert.deepEqual(findTerms(`uses ${s} here`, t), [{ line: 1, termIndex: 1 }]);
});

test('loose match does not fire on unrelated text', () => {
  const t = [{ index: 1, mode: 'loose', norm: 'sampletool' }];
  assert.deepEqual(findTerms('nothing to see', t), []);
});

test('word mode does not match inside other words', () => {
  const t = [{ index: 2, mode: 'word', norm: 'qzx' }];
  assert.deepEqual(findTerms('a aqzxb', t), []);
  assert.deepEqual(findTerms('line one\nQZX rollout', t), [{ line: 2, termIndex: 2 }]);
});

test('loadTerms skips blanks and # comments, keeps file line numbers', () => {
  const { file, cleanup } = tmpTerms('# c\n\nAcme Corp\nword:QZX\n');
  try {
    assert.deepEqual(loadTerms(file).map(t => [t.index, t.mode, t.norm]),
      [[3, 'loose', 'acmecorp'], [4, 'word', 'qzx']]);
  } finally { cleanup(); }
});

test('missing file throws TERMS_MISSING', () => {
  const { file, cleanup } = tmpTerms(null);
  try {
    const e = codeOf(() => loadTerms(file));
    assert.ok(e instanceof GuardError);
    assert.equal(e.code, 'TERMS_MISSING');
  } finally { cleanup(); }
});

test('empty or comments-only file throws TERMS_EMPTY', () => {
  for (const content of ['', '\n\n', '# only\n# comments\n']) {
    const { file, cleanup } = tmpTerms(content);
    try {
      const e = codeOf(() => loadTerms(file));
      assert.ok(e instanceof GuardError);
      assert.equal(e.code, 'TERMS_EMPTY');
    } finally { cleanup(); }
  }
});

test('error messages never contain a term', () => {
  const { file, cleanup } = tmpTerms('Acme Corp\nword:\n');
  try {
    const e = codeOf(() => loadTerms(file));
    assert.ok(e instanceof GuardError);
    assert.equal(e.code, 'TERMS_INVALID');
    assert.match(e.message, /line 2/);
    assert.doesNotMatch(e.message, /acme/i);
  } finally { cleanup(); }
});

test('word: term containing a space or punctuation is TERMS_INVALID naming only the line', () => {
  const t = tmpTerms('# c\nword:Acme Corp\n');
  try {
    const e = codeOf(() => loadTerms(t.file));
    assert.equal(e.code, 'TERMS_INVALID');
    assert.match(e.message, /line 2/);
    assert.doesNotMatch(e.message, /acme/i);
    assert.match(e.message, /loose/);
  } finally { t.cleanup(); }
});
