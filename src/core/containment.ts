// SPDX-License-Identifier: AGPL-3.0-or-later
// Reading an export run folder without leaving it. The root is resolved once
// with realpath. Entries are examined with lstat, so links are never followed.
// Only regular files of the three export kinds are used: labels.json,
// <ID>.metadata.json (up to 4 MiB) and <ID>.eml. Every open is non-blocking
// and refuses links, and it checks that the open file is the regular file the
// scan saw (same device and inode). A file that changed is rejected and has to
// be scanned again.

import {
  close,
  closeSync,
  constants,
  fstat,
  fstatSync,
  lstatSync,
  open,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs';
import { join } from 'node:path';
import { REJECT_KINDS, type RejectKind } from '../shared/sources';

export { REJECT_KINDS, type RejectKind };

export const MAX_METADATA_BYTES = 4 * 1024 * 1024;
/** labels.json lists every folder and label; this leaves plenty of room. */
export const MAX_LABELS_BYTES = 16 * 1024 * 1024;
export const LABELS_FILE = 'labels.json';
export const METADATA_SUFFIX = '.metadata.json';
export const EML_SUFFIX = '.eml';

export type FileKind = 'labels' | 'metadata' | 'eml';

/** A regular file the scan accepted. `rel` is its name relative to the root. */
export interface FileRef {
  rel: string;
  kind: FileKind;
  dev: bigint;
  ino: bigint;
  size: number;
  mtimeNs: bigint;
}

export interface Rejection {
  rel: string;
  kind: RejectKind;
}

export interface RunScan {
  /** The canonical root every `rel` is relative to. */
  root: string;
  labels: FileRef | null;
  /** By message ID. */
  metadata: Map<string, FileRef>;
  /** By message ID. */
  eml: Map<string, FileRef>;
  rejected: Rejection[];
  /** Regular files that aren't one of the three kinds; they are never read. */
  ignored: number;
}

/** The file-system calls the scan makes; tests replace them. */
export interface ScanFs {
  readdir(path: string): string[];
  lstat(path: string): BigIntStats;
}

export const realFs: ScanFs = {
  readdir: (path) => readdirSync(path),
  lstat: (path) => lstatSync(path, { bigint: true }),
};

export class ContainmentError extends Error {
  constructor(
    readonly kind: RejectKind | 'root_unavailable',
    readonly errno: string | null = null,
  ) {
    super(kind);
  }
}

/** What an lstat or fstat result is, in the terms of the rejection kinds. */
export function entryType(
  st: BigIntStats,
): 'file' | Exclude<RejectKind, 'too_large' | 'changed' | 'unreadable'> {
  if (st.isFile()) return 'file';
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isDirectory()) return 'directory';
  if (st.isFIFO()) return 'fifo';
  if (st.isSocket()) return 'socket';
  if (st.isBlockDevice() || st.isCharacterDevice()) return 'device';
  return 'other_type';
}

/** The kind of export file a name stands for, and its message ID; null for any other name. */
export function fileKindOf(name: string): { kind: FileKind; id: string | null } | null {
  if (name === LABELS_FILE) return { kind: 'labels', id: null };
  if (name.endsWith(METADATA_SUFFIX) && name.length > METADATA_SUFFIX.length) {
    return { kind: 'metadata', id: name.slice(0, -METADATA_SUFFIX.length) };
  }
  if (name.endsWith(EML_SUFFIX) && name.length > EML_SUFFIX.length) {
    return { kind: 'eml', id: name.slice(0, -EML_SUFFIX.length) };
  }
  return null;
}

/** The canonical path of a run folder that exists and is a directory. */
export function resolveRoot(root: string): string {
  let real: string;
  try {
    real = realpathSync(root);
  } catch (err) {
    throw new ContainmentError('root_unavailable', (err as NodeJS.ErrnoException).code ?? null);
  }
  if (!lstatSync(real).isDirectory()) throw new ContainmentError('root_unavailable', 'ENOTDIR');
  return real;
}

function isPlainName(name: string): boolean {
  return (
    name !== '' && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\0')
  );
}

/**
 * Looks at one entry of the run folder: a FileRef for a regular export file,
 * a rejection for anything else that isn't an ordinary ignored file, or null
 * for a regular file of another kind.
 */
export function examine(
  root: string,
  name: string,
  fs: ScanFs = realFs,
): { ref: FileRef; id: string | null } | { rejected: Rejection } | null {
  if (!isPlainName(name)) return null;
  const st = fs.lstat(join(root, name));
  const type = entryType(st);
  if (type !== 'file') return { rejected: { rel: name, kind: type } };
  const kind = fileKindOf(name);
  if (!kind) return null;
  const size = Number(st.size);
  if (
    (kind.kind === 'metadata' && size > MAX_METADATA_BYTES) ||
    (kind.kind === 'labels' && size > MAX_LABELS_BYTES)
  ) {
    return { rejected: { rel: name, kind: 'too_large' } };
  }
  return {
    ref: { rel: name, kind: kind.kind, dev: st.dev, ino: st.ino, size, mtimeNs: st.mtimeNs },
    id: kind.id,
  };
}

export function emptyScan(root: string): RunScan {
  return { root, labels: null, metadata: new Map(), eml: new Map(), rejected: [], ignored: 0 };
}

/** Adds one entry of the run folder to a scan. */
export function addEntry(scan: RunScan, name: string, fs: ScanFs = realFs): void {
  let found;
  try {
    found = examine(scan.root, name, fs);
  } catch {
    // The entry went away between readdir and lstat.
    return;
  }
  if (found === null) {
    scan.ignored += 1;
  } else if ('rejected' in found) {
    scan.rejected.push(found.rejected);
  } else if (found.ref.kind === 'labels') {
    scan.labels = found.ref;
  } else if (found.id !== null) {
    (found.ref.kind === 'metadata' ? scan.metadata : scan.eml).set(found.id, found.ref);
  }
}

/** Scans a run folder: one readdir and one lstat per entry, nothing followed or opened. */
export function scanRun(root: string, fs: ScanFs = realFs): RunScan {
  const scan = emptyScan(root);
  for (const name of fs.readdir(root)) addEntry(scan, name, fs);
  return scan;
}

/** Message counts of a scan. */
export function pairCounts(scan: RunScan): {
  pairs: number;
  metadataOnly: number;
  emlOnly: number;
} {
  let pairs = 0;
  for (const id of scan.metadata.keys()) if (scan.eml.has(id)) pairs += 1;
  return {
    pairs,
    metadataOnly: scan.metadata.size - pairs,
    emlOnly: scan.eml.size - pairs,
  };
}

/** Read-only, without following a link and without blocking. */
const CONTAINED_FLAGS =
  constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** Why the open of a contained file failed, as a ContainmentError. */
function openRefused(err: unknown): ContainmentError {
  // A link swapped in fails with ELOOP; a file that went away, with ENOENT.
  const code = (err as NodeJS.ErrnoException).code ?? null;
  const kind = code === 'ELOOP' ? 'symlink' : code === 'ENOENT' ? 'changed' : 'unreadable';
  return new ContainmentError(kind, code);
}

/** Throws unless the open file is still a regular file with the scanned device and inode. */
function checkOpened(st: BigIntStats, ref: FileRef): void {
  const type = entryType(st);
  if (type !== 'file') throw new ContainmentError(type);
  if (st.dev !== ref.dev || st.ino !== ref.ino) throw new ContainmentError('changed');
}

/**
 * Opens a file the scan accepted: read-only, without following a link and
 * without blocking (a FIFO swapped in after the scan can't hold the open), then
 * checks that it is still a regular file with the scanned device and inode.
 */
export function openContained(root: string, ref: FileRef): number {
  let fd: number;
  try {
    fd = openSync(join(root, ref.rel), CONTAINED_FLAGS);
  } catch (err) {
    throw openRefused(err);
  }
  try {
    checkOpened(fstatSync(fd, { bigint: true }), ref);
    return fd;
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}

/**
 * openContained without blocking the calling thread: the open and the check
 * run on the I/O threads, with the same flags and the same checks, and
 * refusals are the same ContainmentErrors. Resolves with a raw descriptor the
 * caller closes; a file that fails the checks is closed before the rejection.
 */
export function openContainedAsync(root: string, ref: FileRef): Promise<number> {
  return new Promise((resolve, reject) => {
    open(join(root, ref.rel), CONTAINED_FLAGS, (openErr, fd) => {
      if (openErr) {
        reject(openRefused(openErr));
        return;
      }
      fstat(fd, { bigint: true }, (statErr, st) => {
        try {
          if (statErr) throw statErr;
          checkOpened(st, ref);
        } catch (err) {
          close(fd, () => reject(err));
          return;
        }
        resolve(fd);
      });
    });
  });
}

/** A file the scan accepted, opened; or why not, and whether it is gone. */
export type ContainedOpen =
  { ok: true; fd: number; ref: FileRef } | { ok: false; rejection: Rejection; gone: boolean };

/**
 * Opens a file the scan accepted, as openContained does. When the file
 * changed since the scan, it is examined again and, if it is still an
 * acceptable regular file, opened once more with its new identity. The caller
 * closes the descriptor.
 */
export function openWithRescan(root: string, ref: FileRef, fs: ScanFs = realFs): ContainedOpen {
  let current = ref;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return { ok: true, fd: openContained(root, current), ref: current };
    } catch (err) {
      if (!(err instanceof ContainmentError)) throw err;
      if (err.kind !== 'changed' || attempt > 0) {
        const kind: RejectKind = err.kind === 'root_unavailable' ? 'unreadable' : err.kind;
        return { ok: false, rejection: { rel: current.rel, kind }, gone: err.errno === 'ENOENT' };
      }
      // Changed, or gone: the rescan tells which.
      let again;
      try {
        again = examine(root, current.rel, fs);
      } catch (e) {
        const gone = (e as NodeJS.ErrnoException).code === 'ENOENT';
        return { ok: false, rejection: { rel: current.rel, kind: 'changed' }, gone };
      }
      if (again === null) {
        return { ok: false, rejection: { rel: current.rel, kind: 'changed' }, gone: false };
      }
      if ('rejected' in again) return { ok: false, rejection: again.rejected, gone: false };
      current = again.ref;
    }
  }
  return { ok: false, rejection: { rel: current.rel, kind: 'changed' }, gone: false };
}

/** Reads a whole contained file of at most `maxBytes`; a larger one is rejected. */
export function readContained(root: string, ref: FileRef, maxBytes: number): Buffer {
  const fd = openContained(root, ref);
  try {
    const size = Number(fstatSync(fd, { bigint: true }).size);
    if (size > maxBytes) throw new ContainmentError('too_large');
    // Read one byte more than allowed, so a file that grows is caught too.
    const buffer = Buffer.alloc(Math.min(size, maxBytes) + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const n = readSync(fd, buffer, filled, buffer.length - filled, null);
      if (n === 0) break;
      filled += n;
    }
    if (filled > maxBytes) throw new ContainmentError('too_large');
    return buffer.subarray(0, filled);
  } finally {
    closeSync(fd);
  }
}

/** The size limit for reading a file of this kind. */
export function limitFor(kind: FileKind): number {
  if (kind === 'metadata') return MAX_METADATA_BYTES;
  if (kind === 'labels') return MAX_LABELS_BYTES;
  return Number.MAX_SAFE_INTEGER;
}

/**
 * Reads a file the scan accepted. When the file changed since the scan, it is
 * examined again and, if it is still an acceptable regular file, read once
 * more with its new identity. Returns the bytes and the ref they were read
 * with, or the rejection.
 */
export function readWithRescan(
  root: string,
  ref: FileRef,
  fs: ScanFs = realFs,
): { ok: true; bytes: Buffer; ref: FileRef } | { ok: false; rejection: Rejection } {
  let current = ref;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return {
        ok: true,
        bytes: readContained(root, current, limitFor(current.kind)),
        ref: current,
      };
    } catch (err) {
      if (!(err instanceof ContainmentError)) throw err;
      if (err.kind !== 'changed' || attempt > 0) {
        const kind: RejectKind = err.kind === 'root_unavailable' ? 'unreadable' : err.kind;
        return { ok: false, rejection: { rel: current.rel, kind } };
      }
      let again;
      try {
        again = examine(root, current.rel, fs);
      } catch {
        return { ok: false, rejection: { rel: current.rel, kind: 'changed' } };
      }
      if (again === null) return { ok: false, rejection: { rel: current.rel, kind: 'changed' } };
      if ('rejected' in again) return { ok: false, rejection: again.rejected };
      current = again.ref;
    }
  }
  return { ok: false, rejection: { rel: current.rel, kind: 'changed' } };
}

/** Counts of rejections by kind, every kind present. */
export function countRejections(rejected: readonly Rejection[]): Record<RejectKind, number> {
  const counts = Object.fromEntries(REJECT_KINDS.map((k) => [k, 0])) as Record<RejectKind, number>;
  for (const r of rejected) counts[r.kind] += 1;
  return counts;
}
