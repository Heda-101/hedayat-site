import fs from 'node:fs';

export class GuardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GuardError';
    this.code = code;
  }
}

// Printable form of untrusted text (model findings, git config values): no control characters, bounded.
export const clean = (s) => String(s).replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, 300);

export function normalize(s) {
  return s.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function loadTerms(path) {
  let raw;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') throw new GuardError('TERMS_MISSING', 'blocked-terms file not found');
    throw e;
  }
  const terms = [];
  raw.split(/\r?\n/).forEach((line, i) => {
    const index = i + 1;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
    let mode = 'loose';
    let body = trimmed;
    if (/^word:/i.test(trimmed)) {
      mode = 'word';
      body = trimmed.slice(5).trim();
    }
    if (mode === 'word' && /[^\p{L}\p{N}]/u.test(body.normalize('NFKC'))) {
      throw new GuardError('TERMS_INVALID',
        `blocked-terms line ${index}: a "word:" term must be letters and digits only; use a loose line for multi-word names`);
    }
    const norm = normalize(body);
    if (norm === '') {
      throw new GuardError('TERMS_INVALID',
        mode === 'word'
          ? `blocked-terms line ${index} is empty after "word:"`
          : `blocked-terms line ${index} is empty after normalization`);
    }
    terms.push({ index, mode, norm });
  });
  if (terms.length === 0) throw new GuardError('TERMS_EMPTY', 'blocked-terms file has no terms');
  return terms;
}

export function findTerms(text, terms) {
  const hits = [];
  const wordRes = new Map();
  for (const t of terms) {
    if (t.mode === 'word') wordRes.set(t, new RegExp(`\\b${t.norm}\\b`, 'i'));
  }
  text.split(/\r?\n/).forEach((line, i) => {
    const folded = normalize(line);
    const nfkc = line.normalize('NFKC');
    for (const t of terms) {
      const hit = t.mode === 'word' ? wordRes.get(t).test(nfkc) : folded.includes(t.norm);
      if (hit) hits.push({ line: i + 1, termIndex: t.index });
    }
  });
  return hits;
}
