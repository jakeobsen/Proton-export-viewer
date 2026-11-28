// SPDX-License-Identifier: AGPL-3.0-or-later
// Publishing a finished download into the destination folder, never replacing
// anything there.
//
// The staged file is hard-linked to the first free name: link() fails with
// EEXIST when anything has that name, a dangling link included, so nothing is
// overwritten, and a file made there meanwhile only moves the save to the
// next name. If link() fails otherwise (another volume, or the sandbox), the
// file is copied into a hidden temporary file in the destination folder,
// created exclusively, and that one is linked the same way. Every temporary
// and staged file is removed, whatever the outcome. The temporary copy is
// removed only while its path still names the file this publish created:
// the same device, inode and birth time, read from the open file right after
// it was created. A device and inode alone can be handed to a new file once
// the old one is gone, so a file system that reports no birth time leaves
// the copy in place rather than risk removing a file put there. Node can't
// unlink by descriptor, so the check and the unlink are two calls, back to
// back; a file swapped in between them would still be removed.

import { constants, createReadStream, lstatSync, unlinkSync, type BigIntStats } from 'node:fs';
import { link, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { candidates } from './names';

/**
 * A file's device, inode and birth time in nanoseconds, as decimal strings.
 * The birth time is "0" where the file system doesn't report one.
 */
export interface FileId {
  dev: string;
  ino: string;
  birth: string;
}

/** The identity in a file's stats. */
export function fileId(st: BigIntStats): FileId {
  return { dev: st.dev.toString(), ino: st.ino.toString(), birth: st.birthtimeNs.toString() };
}

/** Whether `id` can tell its file from a later one with the same device and inode. */
export function completeId(id: FileId): boolean {
  return /^\d+$/.test(id.dev) && /^\d+$/.test(id.ino) && /^[1-9]\d*$/.test(id.birth);
}

/** What a removal by identity did: a file it kept is `foreign` or `incomplete`. */
export type Removal = 'removed' | 'gone' | 'foreign' | 'incomplete';

/** The file-system calls a publish makes, for tests. */
export interface PublishFs {
  link(from: string, to: string): Promise<void>;
  /**
   * Creates `path` exclusively, mode 0600, tells `created` the new file's
   * identity before writing to it, and fills it with the bytes of `from`. On
   * failure, the file it created is removed if `path` still names it; a file
   * it didn't create is left alone.
   */
  copyNew(from: string, path: string, created: (id: FileId) => void): Promise<void>;
  unlink(path: string): Promise<void>;
  /** Removes `path` now, synchronously. */
  unlinkNow(path: string): void;
  /** The identity of `path`, not following a link. */
  id(path: string): FileId;
}

export const realPublishFs: PublishFs = {
  link: (from, to) => link(from, to),
  copyNew: async (from, path, created) => {
    const handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    let id: FileId | null = null;
    try {
      id = fileId(await handle.stat({ bigint: true }));
      created(id);
      for await (const chunk of createReadStream(from)) {
        const bytes = chunk as Buffer;
        for (let done = 0; done < bytes.length;) {
          done += (await handle.write(bytes, done, bytes.length - done)).bytesWritten;
        }
      }
      await handle.sync();
      await handle.close();
    } catch (err) {
      await handle.close().catch(() => undefined);
      if (id) removeIfSame(realPublishFs, path, id);
      throw err;
    }
  },
  unlink: (path) => unlink(path),
  unlinkNow: (path) => unlinkSync(path),
  id: (path) => fileId(lstatSync(path, { bigint: true })),
};

/**
 * Removes `path` only if it still names the file `id`, by device, inode and
 * birth time; never when `id` has no birth time. The check and the unlink run
 * back to back, synchronously.
 */
export function removeIfSame(fs: PublishFs, path: string, id: FileId): Removal {
  let now: FileId;
  try {
    now = fs.id(path);
  } catch {
    return 'gone';
  }
  if (!completeId(id)) return 'incomplete';
  if (now.dev !== id.dev || now.ino !== id.ino || now.birth !== id.birth) return 'foreign';
  try {
    fs.unlinkNow(path);
    return 'removed';
  } catch {
    return 'gone';
  }
}

export type PublishResult =
  | { ok: true; path: string; method: 'link' | 'copy'; dev: string; ino: string }
  | { ok: false; reason: 'exists' | 'publish' };

export interface PublishOptions {
  fs?: PublishFs;
  /** The path of a new fallback copy in the folder. */
  partialPath: (dir: string) => string;
  /** Notes the fallback copy's path before it is made, and clears the note after. */
  notePartial: (path: string) => void;
  /** Notes the identity of the fallback copy just made, before anything is written to it. */
  ownPartial: (path: string, id: FileId) => void;
  clearNote: () => void;
  /** Told when the fallback copy is left in place: not the file made, or no birth time to tell. */
  onPartialKept?: (reason: 'foreign' | 'incomplete') => void;
  /** Test builds only: take the fallback, as if link() from staging had failed. */
  forceCopy?: boolean;
}

const code = (err: unknown) => (err as NodeJS.ErrnoException).code;

/** Links `from` to the first free name in `dir`. */
async function linkFree(
  fs: PublishFs,
  from: string,
  dir: string,
  name: string,
): Promise<
  { ok: true; path: string } | { ok: false; reason: 'exists' } | { ok: false; err: unknown }
> {
  for (const candidate of candidates(name)) {
    const path = join(dir, candidate);
    try {
      await fs.link(from, path);
      return { ok: true, path };
    } catch (err) {
      if (code(err) !== 'EEXIST') return { ok: false, err };
    }
  }
  return { ok: false, reason: 'exists' };
}

/**
 * Publishes the staged file `staged` into `dir` as `name`, or as the first
 * free numbered variant. The staged file is removed in every case.
 */
export async function publish(
  staged: string,
  dir: string,
  name: string,
  options: PublishOptions,
): Promise<PublishResult> {
  const fs = options.fs ?? realPublishFs;
  const dropStaged = () => fs.unlink(staged).catch(() => undefined);
  const done = (path: string, method: 'link' | 'copy'): PublishResult => {
    let id = { dev: '', ino: '' };
    try {
      id = fs.id(path);
    } catch {
      // Published, but gone already: Show in Finder finds nothing to show.
    }
    return { ok: true, path, method, dev: id.dev, ino: id.ino };
  };

  if (!(__PEV_TEST_HOOKS__ && options.forceCopy)) {
    const linked = await linkFree(fs, staged, dir, name);
    if (linked.ok) {
      await dropStaged();
      return done(linked.path, 'link');
    }
    if ('reason' in linked) {
      await dropStaged();
      return { ok: false, reason: linked.reason };
    }
  }

  // The fallback: a hidden copy in the destination folder, then a link to it.
  const partial = options.partialPath(dir);
  let result: PublishResult = { ok: false, reason: 'publish' };
  let created: FileId | null = null;
  try {
    options.notePartial(partial);
    await fs.copyNew(staged, partial, (id) => {
      created = id;
      options.ownPartial(partial, id);
    });
    // Whether the copy carries the quarantine attribute is checked by the
    // sandboxed self-test, on both publish paths, not by the app: the app has
    // no way to read extended attributes. In the sandbox, macOS quarantines
    // every file the app creates, this copy included.
    const linked = await linkFree(fs, partial, dir, name);
    if (linked.ok) result = done(linked.path, 'copy');
    else if ('reason' in linked) result = { ok: false, reason: linked.reason };
  } catch {
    result = { ok: false, reason: 'publish' };
  } finally {
    if (created) {
      const removal = removeIfSame(fs, partial, created);
      if (removal === 'foreign' || removal === 'incomplete') options.onPartialKept?.(removal);
    }
    options.clearNote();
    await dropStaged();
  }
  return result;
}
