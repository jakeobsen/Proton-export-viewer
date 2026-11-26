// SPDX-License-Identifier: AGPL-3.0-or-later
// Where the reader gets a message from, by rowid.

import type { ReaderInput } from '../../shared/reader-protocol';

export interface OpenedMessage {
  input: ReaderInput;
  /** Releases what the open holds, such as a file descriptor. Called once the job has ended. */
  close(): Promise<void>;
}

export interface ReaderSource {
  /** The message with this rowid, or null when the source has none it may open. */
  open(rowid: number): Promise<OpenedMessage | null>;
}
