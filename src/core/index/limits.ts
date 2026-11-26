// SPDX-License-Identifier: AGPL-3.0-or-later
// Bounds on the index writer's work, and the room it keeps on disk for the WAL.
//
// A write transaction carries at most WRITE_BATCH_PAIRS pairs and
// TXN_INPUT_BYTES of input. Those don't bound how much the WAL grows, so the
// writer also checks the WAL's size before every bounded unit of work (one
// message, one chunk of a merge, one chunk of labels) and rolls the
// transaction back past WAL_STOP. An index cap, when one is set, limits the
// main file's pages, so writes past it fail instead of filling the disk.

import { statSync } from 'node:fs';

/** Room kept for the WAL and the shared-memory file below an index cap. */
export const WAL_HEADROOM = 48 * 1024 * 1024;
export const SHM_HEADROOM = 1024 * 1024;
/**
 * The writer's page cache. A transaction writes to the WAL only when this
 * cache spills or at commit, so between two checks the WAL can grow by at most
 * one bounded unit of work plus this much.
 */
export const WRITER_CACHE_BYTES = 8 * 1024 * 1024;
/**
 * The most the WAL can grow between two checks: one bounded unit of work (a
 * message, whose rows are capped and whose metadata is at most a transaction's
 * input; a chunk of a merge; a chunk of labels) plus a full writer cache.
 */
export const STEP_SLACK = 24 * 1024 * 1024;
/** Before each unit of work the writer stops if the WAL is above this. */
export const WAL_STOP = WAL_HEADROOM - STEP_SLACK;
/** The most pairs one phase-1 write transaction takes. */
export const WRITE_BATCH_PAIRS = 1000;
/** The most input one write transaction takes: metadata bytes in phase 1. */
export const TXN_INPUT_BYTES = 4 * 1024 * 1024;
/** Rows one statement moves when a merge re-points members, keys or per-label rows. */
export const REPOINT_CHUNK = 500;
/** Labels written or removed per checked chunk when labels.json is stored. */
export const LABEL_CHUNK = 500;
/** After a commit leaves the WAL above this, it is checkpointed and truncated. */
export const WAL_TRUNCATE_AT = 4 * 1024 * 1024;
/** How long a checkpoint that readers keep busy is retried. */
export const CHECKPOINT_RETRY_MS = 30_000;
/**
 * Full-text merges never run inside a write transaction (automerge is off and
 * crisis merges are out of reach); each batch is followed by up to this many
 * merge steps of about MERGE_PAGES pages, each in its own transaction.
 */
export const MERGE_PAGES = 500;
export const MERGE_STEPS_PER_BATCH = 4;
export const CRISIS_MERGE = 2000;

export class WalStop extends Error {
  constructor() {
    super('WAL_STOP');
  }
}

/**
 * The writer's check before each unit of work: past `stopBytes` it throws, so
 * the transaction stops (and rolls back) before the WAL can pass
 * `stopBytes + STEP_SLACK`.
 */
export function walGuard(walPath: string, stopBytes: number = WAL_STOP): () => void {
  return () => {
    let size = 0;
    try {
      size = statSync(walPath).size;
    } catch {
      // No WAL yet: nothing written.
    }
    if (size > stopBytes) throw new WalStop();
  };
}

/**
 * The main file's page limit for an index cap: writes past it fail with
 * SQLITE_FULL, so the file can't grow past the cap minus the WAL and
 * shared-memory headroom.
 */
export function maxPages(capBytes: number, pageSize: number): number {
  const pages = Math.floor((capBytes - WAL_HEADROOM - SHM_HEADROOM) / pageSize);
  if (pages < 256) throw new Error('CAP_TOO_SMALL');
  return pages;
}
