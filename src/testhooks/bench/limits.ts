// SPDX-License-Identifier: AGPL-3.0-or-later
// The index's size limit on disk, and the room it keeps for the WAL.

/** Room kept below the cap for the WAL and the shared-memory file. */
export const WAL_HEADROOM = 48 * 1024 * 1024;
export const SHM_HEADROOM = 1024 * 1024;
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
