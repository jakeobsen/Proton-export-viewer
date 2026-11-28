// SPDX-License-Identifier: AGPL-3.0-or-later
// The folder a download is written to before it is published: the app's own,
// in its data folder (inside the container when sandboxed). It is emptied
// when the app starts and quits, and each save removes its own file.
//
// A fallback copy is made in the destination folder, which is never listed.
// Its path is noted here before it is made, and its identity (device, inode
// and birth time, read from the open file) and its folder's real path right
// after it is created, before any byte is written. A copy left behind by a
// crash is removed at the next start only if that path still names that very
// file, in that same folder, and the folder is still outside every export.
// A note without a birth time removes nothing: a device and inode alone can
// name a newer file. Nothing else is ever removed there.

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
import { completeId, fileId, type FileId, type Removal } from './publish';

export const STAGING_DIR = 'save-staging';
/** The note of the fallback copy being made, if any. */
export const PARTIAL_NOTE = 'partial.json';
/** A staged download's name. */
export const STAGED_RE = /^[0-9a-f]{32}\.part$/;
/** A fallback copy's name: hidden, random, and marked as unfinished. */
export const PARTIAL_RE = /^\.[0-9a-f]{32}\.partial$/;

/** Why the sweep left a noted fallback copy in place. */
export type KeptReason = 'foreign' | 'incomplete' | 'export_root';

/**
 * Removes `path` only if it is a regular file with identity `id` (device,
 * inode and birth time; never when `id` has no birth time), its folder's real
 * path is still `real`, and `mayDelete` allows that folder. Node can't unlink
 * by descriptor, so the check and the unlink are two calls, back to back.
 */
export function removeOwned(
  path: string,
  id: FileId,
  real: string,
  mayDelete: (dir: string) => boolean,
): Removal | 'export_root' {
  try {
    if (realpathSync.native(dirname(path)) !== real) return 'foreign';
    const st = lstatSync(path, { bigint: true });
    if (!mayDelete(real)) return 'export_root';
    if (!completeId(id)) return 'incomplete';
    const now = fileId(st);
    if (!st.isFile() || now.dev !== id.dev || now.ino !== id.ino || now.birth !== id.birth) {
      return 'foreign';
    }
    unlinkSync(path);
    return 'removed';
  } catch {
    return 'gone';
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
    this.writeNote({
      path,
      dev: id.dev,
      ino: id.ino,
      birth: id.birth,
      real: realpathSync.native(dirname(path)),
    });
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
   * its folder, then the staging folder's contents. `onKept` hears of a noted
   * copy that is there but left in place, and `onFailed` of a staging folder
   * that couldn't be removed. It never throws: whatever it can't remove stays,
   * and the next sweep tries again.
   */
  sweep(
    mayDelete: (dir: string) => boolean,
    onKept?: (reason: KeptReason) => void,
    onFailed?: () => void,
  ): void {
    try {
      const note = JSON.parse(readFileSync(join(this.dir, PARTIAL_NOTE), 'utf8')) as Record<
        string,
        unknown
      >;
      const { path, dev, ino, birth, real } = note;
      if (typeof path === 'string' && PARTIAL_RE.test(basename(path))) {
        const text = (v: unknown) => (typeof v === 'string' ? v : '');
        let removal: Removal | 'export_root' = 'incomplete';
        if (typeof real === 'string') {
          const id = { dev: text(dev), ino: text(ino), birth: text(birth) };
          removal = removeOwned(path, id, real, mayDelete);
        } else {
          // Noted before it was made: whatever is there, if anything, stays.
          lstatSync(path);
        }
        if (removal !== 'removed' && removal !== 'gone') onKept?.(removal);
      }
    } catch {
      // No note, or nothing left to remove.
    }
    try {
      if (!lstatSync(this.dir).isDirectory()) return;
    } catch {
      return;
    }
    try {
      rmSync(this.dir, { recursive: true, force: true });
    } catch {
      onFailed?.();
    }
  }
}
