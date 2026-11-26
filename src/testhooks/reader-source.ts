// SPDX-License-Identifier: AGPL-3.0-or-later
// Core test hooks: the reader's message source in builds with test hooks. It
// maps rowids to synthetic .eml files under one fixed test folder, or to test
// inputs. A file opens only if it is a regular file inside that folder: no
// links, no other file types, and the file opened is the one that was checked.

import { constants } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';
import type { OpenedMessage, ReaderSource } from '../core/reader/source';
import type { TestInput } from '../shared/reader-protocol';
import { markLoaded } from './marker';

markLoaded();

/** The core test action that sets the source. */
export const READER_SOURCE_ACTION = 'pev-reader-test-source';

export type SourceEntry = { file: string } | { test: TestInput };

export interface SourcePayload {
  root: string;
  entries: Array<[number, SourceEntry]>;
}

const TEST_KINDS = new Set(['generated', 'spin', 'heap', 'throw']);

function isEntry(value: unknown): value is SourceEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as { file?: unknown; test?: { kind?: unknown } };
  if (typeof entry.file === 'string') return true;
  return typeof entry.test?.kind === 'string' && TEST_KINDS.has(entry.test.kind);
}

export function parsePayload(payload: unknown): SourcePayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { root, entries } = payload as { root?: unknown; entries?: unknown };
  if (typeof root !== 'string' || !isAbsolute(root) || !Array.isArray(entries)) return null;
  const valid = entries.every(
    (e: unknown) =>
      Array.isArray(e) &&
      e.length === 2 &&
      Number.isSafeInteger(e[0]) &&
      (e[0] as number) > 0 &&
      isEntry(e[1]),
  );
  return valid ? { root, entries: entries as Array<[number, SourceEntry]> } : null;
}

/**
 * Opens `relative` under `root` (a real path) read-only, or returns null if it
 * isn't a regular file inside it.
 */
export async function openContained(root: string, relative: string): Promise<FileHandle | null> {
  if (
    relative === '' ||
    relative.includes('\0') ||
    isAbsolute(relative) ||
    relative.split(/[\\/]/).includes('..')
  ) {
    return null;
  }
  const full = join(root, relative);
  try {
    const before = await lstat(full);
    // lstat does not follow a link, so a link is never a file here.
    if (!before.isFile()) return null;
    // The real path must be the path itself: no link anywhere along it.
    const real = await realpath(full);
    if (real !== full || !real.startsWith(root + sep)) return null;
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
    const handle = await open(full, flags);
    const after = await handle.stat();
    if (!after.isFile() || after.ino !== before.ino || after.dev !== before.dev) {
      await handle.close();
      return null;
    }
    return handle;
  } catch {
    return null;
  }
}

export class TestReaderSource implements ReaderSource {
  private constructor(
    readonly root: string,
    private readonly entries: Map<number, SourceEntry>,
  ) {}

  /** A source on the folder `root`; null if it is not a folder. */
  static async create(payload: SourcePayload): Promise<TestReaderSource | null> {
    let root: string;
    try {
      root = await realpath(payload.root);
      if (!(await lstat(root)).isDirectory()) return null;
    } catch {
      return null;
    }
    return new TestReaderSource(root, new Map(payload.entries));
  }

  async open(rowid: number): Promise<OpenedMessage | null> {
    const entry = this.entries.get(rowid);
    if (!entry) return null;
    if ('test' in entry) {
      return { input: { kind: 'test', input: entry.test }, close: () => Promise.resolve() };
    }
    const handle = await openContained(this.root, entry.file);
    if (!handle) return null;
    return { input: { kind: 'fd', fd: handle.fd }, close: () => handle.close() };
  }
}
