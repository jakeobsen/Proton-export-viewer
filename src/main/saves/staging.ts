// SPDX-License-Identifier: AGPL-3.0-or-later
// The folder a download is written to before it is published: the app's own,
// in its data folder (inside the container when sandboxed). It is emptied
// when the app starts and quits, and each save removes its own file.
//
// A fallback copy is made in the destination folder, which is never listed.
// Its path is noted here before it is made, and its identity (device and
// inode) and its folder's real path right after it is created, before any
// byte is written. A copy left behind by a crash is removed at the next start
// only if that path still names that very file, in that same folder, and the
// folder is still outside every export. Nothing else is ever removed there.

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { FileId } from './publish';

export const STAGING_DIR = 'save-staging';
/** The note of the fallback copy being made, if any. */
export const PARTIAL_NOTE = 'partial.json';
/** A staged download's name. */
export const STAGED_RE = /^[0-9a-f]{32}\.part$/;
/** A fallback copy's name: hidden, random, and marked as unfinished. */
export const PARTIAL_RE = /^\.[0-9a-f]{32}\.partial$/;

/**
 * Removes `path` only if it is a regular file with identity `id`, its folder's
 * real path is still `real`, and `mayDelete` allows that folder. Quiet
 * otherwise. Node can't unlink by descriptor, so the check and the unlink are
 * two calls.
 */
export function removeOwned(
  path: string,
  id: FileId,
  real: string,
  mayDelete: (dir: string) => boolean,
): boolean {
  try {
    if (realpathSync.native(dirname(path)) !== real) return false;
    if (!mayDelete(real)) return false;
    const st = lstatSync(path, { bigint: true });
    if (!st.isFile() || st.dev.toString() !== id.dev || st.ino.toString() !== id.ino) return false;
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Removes a file or a link, never a folder; quiet if it isn't there. */
export function removeFile(path: string): void {
  try {
    if (lstatSync(path).isDirectory()) return;
    unlinkSync(path);
  } catch {
    // Not there.
  }
}

export class Staging {
  readonly dir: string;

  constructor(userData: string) {
    this.dir = join(userData, STAGING_DIR);
  }

  /**
   * The staging folder, made if missing (0700). Throws if something other
   * than a real folder is in its place.
   */
  ensure(): string {
    try {
      mkdirSync(this.dir, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const st = lstatSync(this.dir);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('staging is not a folder');
    return this.dir;
  }

  /** A new name for a download in the staging folder. */
  newFile(): string {
    return join(this.dir, `${randomBytes(16).toString('hex')}.part`);
  }

  /** A new name for a fallback copy in `dir`. */
  static partialIn(dir: string): string {
    return join(dir, `.${randomBytes(16).toString('hex')}.partial`);
  }

  /** Notes the fallback copy about to be made, before it is created. */
  notePartial(path: string): void {
    this.writeNote({ path });
  }

  /** Notes the identity of the fallback copy just created, and its folder's real path. */
  ownPartial(path: string, id: FileId): void {
    this.writeNote({ path, dev: id.dev, ino: id.ino, real: realpathSync.native(dirname(path)) });
  }

  /** Replaces the note whole: a crash leaves the old note or the new one. */
  private writeNote(note: Record<string, string>): void {
    const target = join(this.ensure(), PARTIAL_NOTE);
    const tmp = `${target}.tmp`;
    removeFile(tmp);
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, JSON.stringify(note));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, target);
  }

  clearNote(): void {
    removeFile(join(this.dir, PARTIAL_NOTE));
  }

  /**
   * Removes everything a save left: a noted fallback copy, if its path still
   * names the file the app created (see removeOwned) and `mayDelete` allows
   * its folder, then the staging folder's contents.
   */
  sweep(mayDelete: (dir: string) => boolean): void {
    try {
      const note = JSON.parse(readFileSync(join(this.dir, PARTIAL_NOTE), 'utf8')) as Record<
        string,
        unknown
      >;
      const { path, dev, ino, real } = note;
      if (
        typeof path === 'string' &&
        PARTIAL_RE.test(basename(path)) &&
        typeof dev === 'string' &&
        typeof ino === 'string' &&
        typeof real === 'string'
      ) {
        removeOwned(path, { dev, ino }, real, mayDelete);
      }
    } catch {
      // No note, or nothing left to remove.
    }
    try {
      if (!lstatSync(this.dir).isDirectory()) return;
    } catch {
      return;
    }
    rmSync(this.dir, { recursive: true, force: true });
  }
}
