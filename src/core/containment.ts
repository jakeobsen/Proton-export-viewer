// SPDX-License-Identifier: AGPL-3.0-or-later
// Reading an export run folder without leaving it. The root is resolved once
// with realpath. The folder is listed with each entry's type, as the
// directory gives it; an entry of unknown type is looked at with lstat. Links
// are never followed. Only regular files of the three export kinds are used:
// labels.json, <ID>.metadata.json and <ID>.eml. The listing records metadata
// and message files by name only; their identity (device, inode, size and
// time) comes from their first contained open, or from an lstat where no open
// is made. Every open is non-blocking and refuses links, checks that the open
// file is a regular file and, once a file has an identity, that it is still
// the same file. A file that changed is rejected and has to be looked at
// again. Reads stop one byte past the file kind's limit, whatever size the
// file claims.

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  type BigIntStats,
  type Dirent,
} from 'node:fs';
import { readdir } from 'node:fs/promises';
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

/**
 * A metadata or message file the listing found, by name only. `rel` is its
 * name relative to the root. It has no identity yet: a name-only listing
 * can't tell one regular file from another put in its place, so the first
 * contained open of the file defines which file it is.
 */
export interface ListedFile {
  rel: string;
  kind: FileKind;
}

/** A regular file with its identity, from an lstat or from the fstat of its open. */
export interface FileRef extends ListedFile {
  dev: bigint;
  ino: bigint;
  size: number;
  mtimeNs: bigint;
}

/** Whether a file has an identity that an open must match. */
export function hasIdentity(file: ListedFile | FileRef): file is FileRef {
  return 'ino' in file;
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
  metadata: Map<string, ListedFile>;
  /** By message ID. */
  eml: Map<string, ListedFile>;
  rejected: Rejection[];
  /** Regular files that aren't one of the three kinds; they are never read. */
  ignored: number;
}

/** An entry's type as the listing gives it; `unknown` where the directory doesn't say. */
export type EntryType = 'file' | 'symlink' | 'directory' | 'fifo' | 'socket' | 'device' | 'unknown';

export interface ListedEntry {
  name: string;
  type: EntryType;
}

/** The file-system calls the scan makes; tests replace them. */
export interface ScanFs {
  /** The folder's entries with their types. */
  list(path: string): ListedEntry[];
  /** The folder's entry names only. */
  readdir(path: string): string[];
  lstat(path: string): BigIntStats;
}

/** The same listing calls, made off the main thread. */
export interface ListFs {
  list(path: string): Promise<ListedEntry[]>;
  readdir(path: string): Promise<string[]>;
}

/**
 * An entry's type from a directory entry. Node looks at an entry of unknown
 * type with lstat itself; a type it can't name stays unknown here and is
 * looked at again.
 */
export function typeOf(entry: Dirent): EntryType {
  if (entry.isFile()) return 'file';
  if (entry.isSymbolicLink()) return 'symlink';
  if (entry.isDirectory()) return 'directory';
  if (entry.isFIFO()) return 'fifo';
  if (entry.isSocket()) return 'socket';
  if (entry.isBlockDevice() || entry.isCharacterDevice()) return 'device';
  return 'unknown';
}

const typed = (entries: Dirent[]): ListedEntry[] =>
  entries.map((entry) => ({ name: entry.name, type: typeOf(entry) }));

export const realFs: ScanFs = {
  list: (path) => typed(readdirSync(path, { withFileTypes: true })),
  readdir: (path) => readdirSync(path),
  lstat: (path) => lstatSync(path, { bigint: true }),
};

export const realListFs: ListFs = {
  list: async (path) => typed(await readdir(path, { withFileTypes: true })),
  readdir: (path) => readdir(path),
};

export class ContainmentError extends Error {
  constructor(
    readonly kind: RejectKind | 'root_unavailable',
    readonly errno: string | null = null,
    /** Bytes read before the file was refused. */
    readonly read = 0,
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
 * Whether a size an lstat gave is over the file kind's limit. Where a file is
 * looked at with lstat anyway, a file over its limit is refused without being
 * read; every read also stops one byte past the limit, whatever the size.
 */
export function overLimit(kind: FileKind, size: number): boolean {
  return (
    (kind === 'metadata' && size > MAX_METADATA_BYTES) ||
    (kind === 'labels' && size > MAX_LABELS_BYTES)
  );
}

/** A FileRef from an lstat or fstat result. */
export function refOf(rel: string, kind: FileKind, st: BigIntStats): FileRef {
  return { rel, kind, dev: st.dev, ino: st.ino, size: Number(st.size), mtimeNs: st.mtimeNs };
}

/**
 * Looks at one entry of the run folder with lstat: a FileRef for a regular
 * export file, a rejection for anything else that isn't an ordinary ignored
 * file, or null for a regular file of another kind. A file over its kind's
 * size limit is refused.
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
  if (overLimit(kind.kind, Number(st.size))) return { rejected: { rel: name, kind: 'too_large' } };
  return { ref: refOf(name, kind.kind, st), id: kind.id };
}

export function emptyScan(root: string): RunScan {
  return { root, labels: null, metadata: new Map(), eml: new Map(), rejected: [], ignored: 0 };
}

/**
 * Adds one listed entry of the run folder to a scan. A regular metadata or
 * message file is recorded by name; labels.json, and an entry the listing
 * gave no type for, are looked at with lstat. Any other type is rejected
 * without a look.
 */
export function addEntry(scan: RunScan, entry: ListedEntry, fs: ScanFs = realFs): void {
  const { name, type } = entry;
  if (!isPlainName(name)) {
    scan.ignored += 1;
    return;
  }
  if (type !== 'file' && type !== 'unknown') {
    scan.rejected.push({ rel: name, kind: type });
    return;
  }
  const kind = fileKindOf(name);
  if (type === 'file' && kind && kind.id !== null) {
    (kind.kind === 'metadata' ? scan.metadata : scan.eml).set(kind.id, {
      rel: name,
      kind: kind.kind,
    });
    return;
  }
  if (type === 'file' && !kind) {
    scan.ignored += 1;
    return;
  }
  let found;
  try {
    found = examine(scan.root, name, fs);
  } catch {
    // The entry went away between the listing and lstat.
    return;
  }
  if (found === null) {
    scan.ignored += 1;
  } else if ('rejected' in found) {
    scan.rejected.push(found.rejected);
  } else if (found.ref.kind === 'labels') {
    scan.labels = found.ref;
  } else if (found.id !== null) {
    (found.ref.kind === 'metadata' ? scan.metadata : scan.eml).set(found.id, {
      rel: found.ref.rel,
      kind: found.ref.kind,
    });
  }
}

/** The names of a listing that has no types: each is looked at with lstat. */
const untyped = (names: string[]): ListedEntry[] =>
  names.map((name) => ({ name, type: 'unknown' }));

/**
 * The run folder's entries with their types. Node looks at an entry of
 * unknown type with lstat while it lists, and an entry that goes away in
 * that moment fails the whole listing; the folder is then listed by name
 * only, and every entry is looked at on its own. If that fails too, so does
 * the listing.
 */
export function listRun(root: string, fs: ScanFs = realFs): ListedEntry[] {
  try {
    return fs.list(root);
  } catch {
    return untyped(fs.readdir(root));
  }
}

/** The same listing as `listRun`, off the main thread. */
export async function listRunAsync(root: string, fs: ListFs = realListFs): Promise<ListedEntry[]> {
  try {
    return await fs.list(root);
  } catch {
    return untyped(await fs.readdir(root));
  }
}

/** Scans a run folder: one listing, nothing followed or opened, lstat only where it's needed. */
export function scanRun(root: string, fs: ScanFs = realFs): RunScan {
  const scan = emptyScan(root);
  for (const entry of listRun(root, fs)) addEntry(scan, entry, fs);
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

/**
 * Opens a listed file: read-only, without following a link and without
 * blocking (a FIFO put in its place can't hold the open), then checks with
 * fstat that it is a regular file. A file with an identity must still have
 * its device and inode. A file listed by name only gets its identity from
 * this open: any regular file at that name when it is opened is the file.
 * Returns the descriptor and the identity of the file opened; the caller
 * closes the descriptor.
 */
export function openListed(root: string, file: ListedFile | FileRef): { fd: number; ref: FileRef } {
  let fd: number;
  try {
    fd = openSync(
      join(root, file.rel),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch (err) {
    // A link put in its place fails with ELOOP; a file that went away, with ENOENT.
    const code = (err as NodeJS.ErrnoException).code ?? null;
    const kind = code === 'ELOOP' ? 'symlink' : code === 'ENOENT' ? 'changed' : 'unreadable';
    throw new ContainmentError(kind, code);
  }
  try {
    const st = fstatSync(fd, { bigint: true });
    const type = entryType(st);
    if (type !== 'file') throw new ContainmentError(type);
    if (hasIdentity(file) && (st.dev !== file.dev || st.ino !== file.ino)) {
      throw new ContainmentError('changed');
    }
    return { fd, ref: refOf(file.rel, file.kind, st) };
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}

/** Opens a file with an identity, as openListed does; returns the descriptor. */
export function openContained(root: string, ref: FileRef): number {
  return openListed(root, ref).fd;
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

/** Bytes asked for per read. */
const READ_CHUNK = 64 * 1024;
let scratch: Buffer | null = null;

/**
 * Reads an open file to its end, but never more than `maxBytes` + 1 bytes,
 * in chunks of at most 64 KiB; past `maxBytes` the file is too large. Only
 * the bytes the reads return count: no size the file claims decides the
 * limit or the memory taken.
 */
export function readCapped(fd: number, maxBytes: number): Buffer {
  scratch ??= Buffer.allocUnsafe(READ_CHUNK);
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const want = Math.min(READ_CHUNK, maxBytes + 1 - total);
    if (want <= 0) break;
    const n = readSync(fd, scratch, 0, want, null);
    if (n === 0) break;
    chunks.push(Buffer.from(scratch.subarray(0, n)));
    total += n;
  }
  if (total > maxBytes) throw new ContainmentError('too_large', null, total);
  return chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, total);
}

/**
 * Reads a whole listed file of at most `maxBytes` through openListed; a
 * larger one is rejected. Returns the bytes and the identity of the file read.
 */
export function readListed(
  root: string,
  file: ListedFile | FileRef,
  maxBytes: number,
): { bytes: Buffer; ref: FileRef } {
  const { fd, ref } = openListed(root, file);
  try {
    return { bytes: readCapped(fd, maxBytes), ref };
  } finally {
    closeSync(fd);
  }
}

/** Reads a whole contained file of at most `maxBytes`; a larger one is rejected. */
export function readContained(root: string, ref: ListedFile | FileRef, maxBytes: number): Buffer {
  return readListed(root, ref, maxBytes).bytes;
}

/** The size limit for reading a file of this kind. */
export function limitFor(kind: FileKind): number {
  if (kind === 'metadata') return MAX_METADATA_BYTES;
  if (kind === 'labels') return MAX_LABELS_BYTES;
  return Number.MAX_SAFE_INTEGER;
}

/**
 * Reads a listed file. A file with an identity that changed since it was
 * looked at, or one that went away, is examined again and, if it is still
 * an acceptable regular file, read once more with its new identity. Returns
 * the bytes and the identity of the file they were read from (its fstat), or
 * the rejection, with the bytes read before it when there were any.
 */
export function readWithRescan(
  root: string,
  file: ListedFile | FileRef,
  fs: ScanFs = realFs,
): { ok: true; bytes: Buffer; ref: FileRef } | { ok: false; rejection: Rejection; read?: number } {
  let current: ListedFile | FileRef = file;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const read = readListed(root, current, limitFor(current.kind));
      return { ok: true, bytes: read.bytes, ref: read.ref };
    } catch (err) {
      if (!(err instanceof ContainmentError)) throw err;
      if (err.kind !== 'changed' || attempt > 0) {
        const kind: RejectKind = err.kind === 'root_unavailable' ? 'unreadable' : err.kind;
        const rejection = { rel: current.rel, kind };
        return err.read > 0 ? { ok: false, rejection, read: err.read } : { ok: false, rejection };
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

/**
 * Looks at a listed file with lstat (never following a link): its identity
 * if it is a regular file, the rejection if it is now of another type or
 * over its size limit, or null if it is gone or can't be looked at.
 */
export function statListed(
  root: string,
  file: ListedFile,
  fs: ScanFs = realFs,
): { ref: FileRef } | { rejected: Rejection } | null {
  let st: BigIntStats;
  try {
    st = fs.lstat(join(root, file.rel));
  } catch {
    return null;
  }
  const type = entryType(st);
  if (type !== 'file') return { rejected: { rel: file.rel, kind: type } };
  if (overLimit(file.kind, Number(st.size))) {
    return { rejected: { rel: file.rel, kind: 'too_large' } };
  }
  return { ref: refOf(file.rel, file.kind, st) };
}

/** The rejection kinds the listing and the looks after it report; the others are pair codes only. */
export const SCAN_KINDS: readonly RejectKind[] = [
  'symlink',
  'directory',
  'fifo',
  'socket',
  'device',
  'other_type',
  'too_large',
];

/** Counts of rejections by kind, every kind present. */
export function countRejections(rejected: readonly Rejection[]): Record<RejectKind, number> {
  const counts = Object.fromEntries(REJECT_KINDS.map((k) => [k, 0])) as Record<RejectKind, number>;
  for (const r of rejected) counts[r.kind] += 1;
  return counts;
}
