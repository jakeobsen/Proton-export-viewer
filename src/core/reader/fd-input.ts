// SPDX-License-Identifier: AGPL-3.0-or-later
// Reading a message from a file core opened: by position, from the start,
// leaving the descriptor open for core to close. The second read for inline
// images uses the same descriptor, so it reads the same file, and checks with
// fstat that the file's size and modification time are as they were before
// the first read.

import { fstatSync, type BigIntStats } from 'node:fs';
import type { Readable } from 'node:stream';
import { borrowedFdStream } from '../fd-stream';
import type { Reread } from './images';

/**
 * The message from its start, read through core's descriptor, which stays
 * open even when the read is cut short.
 */
export function fdRead(fd: number): Readable {
  return borrowedFdStream(fd, { start: 0 });
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.size === b.size && a.mtimeNs === b.mtimeNs;
}

/**
 * The second read of the message in `fd`. Call before the first read starts:
 * that is the state `unchanged` compares with.
 */
export function fdReread(fd: number, between?: () => Promise<void>): Reread {
  const before = fstatSync(fd, { bigint: true });
  return {
    open: () => Promise.resolve(fdRead(fd)),
    unchanged: () => Promise.resolve(sameFile(before, fstatSync(fd, { bigint: true }))),
    ...(between ? { between } : {}),
  };
}
