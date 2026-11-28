// SPDX-License-Identifier: AGPL-3.0-or-later
// A read stream over a file descriptor someone else owns and closes. A
// pipeline destroys its streams on any error, and a destroyed fs stream
// closes its descriptor whatever autoClose says; this one never does, so the
// owner's close is the only one, and no other file that got the same number
// in between is closed by mistake.

import { createReadStream, read } from 'node:fs';
import type { Readable } from 'node:stream';

/** Reads by position from `fd` and leaves it open, even when destroyed. */
export function borrowedFdStream(
  fd: number,
  range: { start?: number; end?: number } = {},
): Readable {
  return createReadStream('', {
    fd,
    autoClose: false,
    fs: {
      read,
      close: (_fd: number, callback: (err: NodeJS.ErrnoException | null) => void) => callback(null),
    },
    ...range,
  });
}
