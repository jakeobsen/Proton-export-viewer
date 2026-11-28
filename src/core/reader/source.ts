// SPDX-License-Identifier: AGPL-3.0-or-later
// Where the reader gets a message from, by rowid.

import type { FileIdentity, ReaderInput } from '../../shared/reader-protocol';

export interface OpenedMessage {
  input: ReaderInput;
  /** The identity of the file opened; null for an input that is no file. */
  file: FileIdentity | null;
  /** Releases what the open holds, such as a file descriptor. Called once the job has ended. */
  close(): Promise<void>;
}

/** Where a message's file is: its path, or why it isn't shown. */
export type LocatedFile =
  | { ok: true; path: string }
  | {
      ok: false;
      code: 'no_source' | 'superseded' | 'unavailable' | 'not_found' | 'eml_missing' | 'changed';
    };

/** A message's file opened for a save, or why it isn't. */
export type SaveOpen =
  | { ok: true; fd: number; close(): void }
  | {
      ok: false;
      code: 'no_source' | 'superseded' | 'unavailable' | 'not_found' | 'eml_missing' | 'changed';
    };

export interface ReaderSource {
  /** The message with this rowid, or null when the source has none it may open. */
  open(rowid: number): Promise<OpenedMessage | null>;
  /**
   * The path of the message's file while it is still the file with this
   * identity, checked through a contained open.
   */
  locate(rowid: number, file: FileIdentity): Promise<LocatedFile>;
  /**
   * The message's file, opened read-only through a contained open, while it
   * is still the file with this identity. The caller closes it.
   */
  openForSave(rowid: number, file: FileIdentity): Promise<SaveOpen>;
}
