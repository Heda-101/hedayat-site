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
      if (status[0] === 'A') paths.push(tok[i + 1]);
      i += 2;
    }
  }
  return paths;
}

// Image files added (or renamed/copied to) anywhere in the pushed ranges. Throws on any git error.
export function newImagesInPush(refs, cwd = process.cwd()) {
  const found = new Set();
  for (const ref of refs) {
    const range = effectiveRevs(ref, cwd);
    if (range.kind === 'delete') continue;
    const out = git(['log', '-m', '-M', '-C', '--name-status', '-z', '--format=', ...range.revs], cwd);
    for (const p of parseNameStatus(out)) if (isImagePath(p)) found.add(p);
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
    process.stderr.write(`New images in this push:\n${paths.map((p) => `  ${p}\n`).join('')}`);
    process.stderr.write('Confirm these images contain no client or confidential content [y/N] ');
    return /^\s*y\s*$/i.test(readLine(fd));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}
