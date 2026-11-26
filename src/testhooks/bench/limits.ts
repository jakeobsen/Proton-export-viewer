// SPDX-License-Identifier: AGPL-3.0-or-later
// The index's size limit on disk, and the room it keeps for the WAL.

import { statSync } from 'node:fs';

/** Room kept below the cap for the WAL and the shared-memory file. */
export const WAL_HEADROOM = 48 * 1024 * 1024;
export const SHM_HEADROOM = 1024 * 1024;
/**
 * The writer's page cache. A transaction writes to the WAL only when this
 * cache spills or at commit, so between two of the writer's checks the WAL can
 * grow by at most one bounded unit of work plus this much.
 */
export const WRITER_CACHE_BYTES = 8 * 1024 * 1024;
/**
 * The most one bounded unit of work (a message whose metadata fills a
 * transaction's input, a chunk of a merge, a body, a merge step) plus a cache
 * flush can add to the WAL. A test measures each kind at its worst on a
 * populated index (largest: about 14 MiB) against this.
 */
export const STEP_SLACK = 24 * 1024 * 1024;
/** Before each unit of work the writer stops if the WAL is above this. */
export const WAL_STOP = WAL_HEADROOM - STEP_SLACK;
/**
 * The writer's check before each unit of work: past `stopBytes` it throws, so
 * the transaction stops (and rolls back) before the WAL can pass
 * `stopBytes + STEP_SLACK`. `onSize` sees every size it read.
 */
export function walGuard(
  walPath: string,
  stopBytes: number,
  onSize: (bytes: number) => void = () => {},
) {
  return (): void => {
    let size = 0;
    try {
      size = statSync(walPath).size;
    } catch {
      // No WAL yet: nothing written.
    }
    onSize(size);
    if (size > stopBytes) throw new Error('WAL_STOP');
  };
}

/** The most input one write transaction takes: metadata bytes in phase 1, text in phase 2. */
export const TXN_INPUT_BYTES = 4 * 1024 * 1024;
/** After a commit leaves the WAL above this, it is checkpointed and truncated. */
export const WAL_TRUNCATE_AT = 4 * 1024 * 1024;
/** How long a checkpoint that readers keep busy is retried before the run fails. */
export const CHECKPOINT_RETRY_MS = 30_000;
/**
 * Full-text merges never run inside a write transaction (automerge is off and
 * crisis merges are out of reach); instead each batch is followed by up to this
 * many merge steps of about MERGE_PAGES pages each, in their own transactions,
 * so no single transaction can add an unbounded amount to the WAL.
 */
export const MERGE_PAGES = 500;
export const MERGE_STEPS_PER_BATCH = 4;
export const CRISIS_MERGE = 2000;

/**
 * The main file's page limit: writes past it fail with SQLITE_FULL, so the
 * file can't grow past the cap minus the WAL and shared-memory headroom.
 */
export function maxPages(capBytes: number, pageSize: number): number {
  const pages = Math.floor((capBytes - WAL_HEADROOM - SHM_HEADROOM) / pageSize);
  if (pages < 256) throw new Error('CAP_TOO_SMALL');
  return pages;
}
