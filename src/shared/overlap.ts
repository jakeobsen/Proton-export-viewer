// SPDX-License-Identifier: AGPL-3.0-or-later
// Whether two places on disk overlap: one is the other or lies inside it.
// Links are resolved as far as the places exist. On macOS and Windows, whose
// file systems usually ignore case, paths are compared without case, which
// errs towards finding an overlap.

import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** The path with every link resolved, for the part of it that exists. */
export function realPath(path: string): string {
  let head = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(head), ...tail.reverse());
    } catch {
      const parent = dirname(head);
      if (parent === head) return resolve(path);
      tail.push(basename(head));
      head = parent;
    }
  }
}

const fold = (path: string) => (process.platform === 'linux' ? path : path.toLowerCase());

function within(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** True if `a` and `b` are the same place, or one lies inside the other. */
export function overlaps(a: string, b: string): boolean {
  const x = fold(realPath(a));
  const y = fold(realPath(b));
  return within(x, y) || within(y, x);
}
