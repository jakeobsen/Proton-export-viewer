// SPDX-License-Identifier: AGPL-3.0-or-later
// A bounded copy of a folder for tests that change their copy.

import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  utimesSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { walk } from '../src/testhooks/proof/fs';

/**
 * Copies the folder `src` to `dest`, which must not exist yet: folders and
 * regular files only (anything else is refused before the copy starts), with
 * their permission bits and modification times, so the copy allows and
 * denies the same changes as the original. At most `cap` bytes of file
 * content are copied: the sizes are summed before the copy starts, and the
 * bytes are counted again while copying. Returns the number of bytes copied.
 */
export function copyTree(src: string, dest: string, cap: number): number {
  const entries = walk(src);
  let planned = 0;
  for (const entry of entries) {
    if (entry.type !== 'dir' && entry.type !== 'file') {
      throw new Error(`refusing to copy ${src}: ${entry.path} is not a folder or a file`);
    }
    if (entry.type === 'file') planned += lstatSync(entry.full).size;
  }
  if (planned > cap) {
    throw new Error(`refusing to copy ${src}: ${planned} bytes is over the cap of ${cap}`);
  }
  mkdirSync(dest);
  let copied = 0;
  for (const entry of entries) {
    const target = join(dest, ...entry.path.split('/'));
    if (entry.type === 'dir') {
      mkdirSync(target);
      continue;
    }
    const bytes = readFileSync(entry.full);
    copied += bytes.length;
    if (copied > cap) throw new Error(`stopped copying ${src}: over the cap of ${cap} bytes`);
    writeFileSync(target, bytes, { flag: 'wx' });
  }
  // Modes and times last, children before their folder, once every file is
  // written: a read-only folder can't take new files.
  const copies: Array<[string, string]> = entries.map((entry) => [
    entry.full,
    join(dest, ...entry.path.split('/')),
  ]);
  for (const [from, to] of [...copies.reverse(), [src, dest] as [string, string]]) {
    const { atime, mtime, mode } = lstatSync(from);
    chmodSync(to, mode & 0o777);
    utimesSync(to, atime, mtime);
  }
  return copied;
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Gives the owner full access to `dir` and every folder inside it again, so
 * a read-only copy can be removed. `dir` must be a real folder directly
 * inside `parent`, which must be a real folder too, and physically where its
 * path says. Links are never followed and files keep their modes. A missing
 * `dir` is fine.
 */
export function unlockFolders(parent: string, dir: string): void {
  const container = resolve(parent);
  const target = resolve(dir);
  if (dirname(target) !== container) {
    throw new Error(`refusing to change ${dir}: not a folder directly inside ${parent}`);
  }
  const stat = lstatOrNull(target);
  if (stat === null) return;
  if (!lstatSync(container).isDirectory() || !stat.isDirectory()) {
    throw new Error(`refusing to change ${dir}: it or ${parent} is not a folder`);
  }
  if (realpathSync(target) !== join(realpathSync(container), basename(target))) {
    throw new Error(`refusing to change ${dir}: it is physically elsewhere`);
  }
  const visit = (path: string) => {
    const entry = lstatSync(path);
    if (!entry.isDirectory()) return;
    chmodSync(path, (entry.mode & 0o777) | 0o700);
    for (const name of readdirSync(path)) visit(join(path, name));
  };
  visit(target);
}
