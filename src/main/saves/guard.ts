// SPDX-License-Identifier: AGPL-3.0-or-later
// A save never writes into an export. Before any file is made, the folder it
// goes to is resolved to its real path, and each of its folders up to the root
// is compared by device and inode with every export the app knows. That holds
// whatever the case of the names, on any volume, and through links and
// aliases. The real paths are compared as well, without case where file
// systems usually ignore it; either match refuses the save.

import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** The file-system calls the guard makes, for tests. */
export interface GuardFs {
  realpath(path: string): string;
  /** Device and inode, following links. */
  id(path: string): string;
}

export const realGuardFs: GuardFs = {
  realpath: (path) => realpathSync.native(path),
  id: (path) => {
    const st = statSync(path, { bigint: true });
    return `${st.dev}:${st.ino}`;
  },
};

/** The real path of the part of `path` that exists, and the rest of it. */
function realHead(path: string, fs: GuardFs): { head: string; tail: string[] } {
  let head = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      return { head: fs.realpath(head), tail: tail.reverse() };
    } catch {
      const parent = dirname(head);
      if (parent === head) throw new Error('no existing folder');
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

/**
 * Whether `dir`, existing or not yet, is an export root in `roots` or lies
 * inside one. A folder that can't be checked counts as inside.
 */
export function insideExport(dir: string, roots: readonly string[], fs = realGuardFs): boolean {
  let head: string;
  let tail: string[];
  try {
    ({ head, tail } = realHead(dir, fs));
  } catch {
    return true;
  }
  const chain = new Set<string>();
  try {
    for (let at = head; ; at = dirname(at)) {
      chain.add(fs.id(at));
      if (dirname(at) === at) break;
    }
  } catch {
    return true;
  }
  const real = fold(join(head, ...tail));
  for (const root of roots) {
    try {
      if (chain.has(fs.id(root))) return true;
    } catch {
      // An export that isn't there now: its path is still compared below.
    }
    let rootReal: string;
    try {
      const found = realHead(root, fs);
      rootReal = join(found.head, ...found.tail);
    } catch {
      rootReal = resolve(root);
    }
    if (within(real, fold(rootReal))) return true;
  }
  return false;
}
