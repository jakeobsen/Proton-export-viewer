// SPDX-License-Identifier: AGPL-3.0-or-later
// Walks a generated corpus: its digest, its size on disk, and its entries.
// FIFOs are listed but never opened, and symbolic links are never followed.

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every entry under `root`, depth first, in byte order of names:
 * {path (relative, "/" separated), type, size, blocks, mtime (whole seconds)}.
 */
export function walk(root) {
  const out = [];
  const visit = (dir, prefix) => {
    const names = readdirSync(dir).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    for (const name of names) {
      const full = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = lstatSync(full);
      const type = st.isSymbolicLink()
        ? 'symlink'
        : st.isDirectory()
          ? 'dir'
          : st.isFIFO()
            ? 'fifo'
            : st.isFile()
              ? 'file'
              : 'other';
      out.push({
        path: rel,
        full,
        type,
        size: st.size,
        blocks: st.blocks,
        mtime: Math.floor(st.mtimeMs / 1000),
      });
      if (type === 'dir') visit(full, rel);
    }
  };
  visit(root, '');
  return out;
}

/** Bytes the tree takes on disk (allocated blocks), the root included. */
export function diskBytes(root) {
  let blocks = lstatSync(root).blocks;
  for (const entry of walk(root)) blocks += entry.blocks;
  return blocks * 512;
}

/**
 * The corpus digest: SHA-256 over one line per entry, in walk order:
 * "<type> <path> <mtime> <SHA-256 of the content | link target | ->".
 */
export function digest(root) {
  const hash = createHash('sha256');
  for (const entry of walk(root)) {
    let detail = '-';
    if (entry.type === 'file') {
      detail = createHash('sha256').update(readFileSync(entry.full)).digest('hex');
    } else if (entry.type === 'symlink') {
      detail = readlinkSync(entry.full);
    }
    hash.update(`${entry.type} ${entry.path} ${entry.mtime} ${detail}\n`);
  }
  return hash.digest('hex');
}
