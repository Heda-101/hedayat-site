import fs from 'node:fs';
import { git, effectiveRevs, changedPaths } from './scope.mjs';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|heic|bmp|tiff|ico)$/i;

export function isImagePath(p) {
  return IMAGE_EXT.test(p);
}

// .gitattributes at any depth: it changes how git diffs (and so how tools read) other files.
export function isAttributesPath(p) {
  return /(^|\/)\.gitattributes$/i.test(p); // any case: the Mac file system ignores it
}

// Files a human must confirm (R23), anywhere in the pushed ranges, when a commit adds, modifies,
// type-changes or renames/copies to them:
// - images, by name;
// - any file that is binary by CONTENT (NUL byte, UTF-16 mark, invalid UTF-8; see
//   scope.mjs isBinaryContent), because the term scan and the AI review cannot read it.
//   Content decides, never .gitattributes or .git/info/attributes;
// - .gitattributes itself.
// Throws on any git error.
export function heldFilesInPush(refs, cwd = process.cwd()) {
  const found = new Set();
  for (const ref of refs) {
    const range = effectiveRevs(ref, cwd);
    if (range.kind === 'delete') continue;
    for (const sha of git(['rev-list', ...range.revs], cwd).split('\n').filter(Boolean)) {
      const { changed, binary } = changedPaths(sha, cwd);
      for (const p of changed) if (isImagePath(p) || isAttributesPath(p) || binary.includes(p)) found.add(p);
    }
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
    process.stderr.write(`New images, binary files or .gitattributes changes in this push:\n${paths.map((p) => `  ${p}\n`).join('')}`);
    process.stderr.write('Confirm these images and binary files contain no client or confidential content [y/N] ');
    return /^\s*y\s*$/i.test(readLine(fd));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}
