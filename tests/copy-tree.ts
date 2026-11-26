// SPDX-License-Identifier: AGPL-3.0-or-later
// A bounded copy of a folder for tests that change their copy.

import { lstatSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { walk } from '../src/testhooks/proof/fs';

/**
 * Copies the folder `src` to `dest`, which must not exist yet: folders and
 * regular files only (anything else is refused before the copy starts), with
 * their modification times. At most `cap` bytes of file content are copied:
 * the sizes are summed before the copy starts, and the bytes are counted again
 * while copying. Returns the number of bytes copied.
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
  // Times last, children before their folder, once every file is written.
  for (const entry of [...entries].reverse()) {
    const { atime, mtime } = lstatSync(entry.full);
    utimesSync(join(dest, ...entry.path.split('/')), atime, mtime);
  }
  return copied;
}
