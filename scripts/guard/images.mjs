import fs from 'node:fs';
import { git, effectiveRevs } from './scope.mjs';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|heic|bmp|tiff|ico)$/i;

export function isImagePath(p) {
  return IMAGE_EXT.test(p);
}

// Parse `git log --name-status -z --format=` output: STATUS NUL path NUL [path NUL for R/C].
function parseNameStatus(out) {
  const tok = out.split('\0');
  const paths = [];
  for (let i = 0; i < tok.length;) {
    const status = tok[i].trim();
    if (!status) { i++; continue; }
    if (/^[RC]/.test(status)) {
      if (tok[i + 2] === undefined) throw new Error('malformed name-status output');
      paths.push(tok[i + 2]);
      i += 3;
    } else {
      if (tok[i + 1] === undefined) throw new Error('malformed name-status output');
      // added, modified (a replaced picture leaks as easily as a new one) or type-changed
      if (/^[AMT]/.test(status)) paths.push(tok[i + 1]);
      i += 2;
    }
  }
  return paths;
}

// Paths git's diff calls binary (numstat "-\t-") anywhere in the range, with renames off so a
// moved file shows under its new name.
function binaryPathsIn(revs, cwd) {
  const out = git(['log', '-m', '--numstat', '-z', '--format=', '--no-renames', '--no-textconv', '--no-ext-diff', ...revs], cwd);
  const found = new Set();
  for (const entry of out.split('\0')) {
    const m = /^\n*(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(entry);
    if (m && m[1] === '-' && m[2] === '-') found.add(m[3]);
  }
  return found;
}

// Files a human must confirm (R23): images, and any other file git treats as binary (NUL bytes,
// UTF-16, PDFs ...), that were added, modified, type-changed or renamed/copied to anywhere in the
// pushed ranges. The term scan and the AI review cannot read them. Throws on any git error.
export function heldFilesInPush(refs, cwd = process.cwd()) {
  const found = new Set();
  for (const ref of refs) {
    const range = effectiveRevs(ref, cwd);
    if (range.kind === 'delete') continue;
    const out = git(['log', '-m', '-M', '-C', '--name-status', '-z', '--format=', ...range.revs], cwd);
    const changed = parseNameStatus(out);
    const binaries = binaryPathsIn(range.revs, cwd);
    for (const p of changed) if (isImagePath(p) || binaries.has(p)) found.add(p);
  }
  return [...found];
}

function readLine(fd) {
  const buf = Buffer.alloc(1);
  let line = '';
  while (line.length < 256 && fs.readSync(fd, buf, 0, 1, null) === 1) {
    if (buf[0] === 10) break;
    line += String.fromCharCode(buf[0]);
  }
  return line;
}

// Ask a human on the terminal. Any failure (no tty, read error) counts as "no".
export function confirmImages(paths, tty = '/dev/tty') {
  let fd;
  try {
    fd = fs.openSync(tty, 'r');
    process.stderr.write(`New images or binary files in this push:\n${paths.map((p) => `  ${p}\n`).join('')}`);
    process.stderr.write('Confirm these images and binary files contain no client or confidential content [y/N] ');
    return /^\s*y\s*$/i.test(readLine(fd));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}
