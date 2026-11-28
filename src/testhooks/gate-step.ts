// SPDX-License-Identifier: AGPL-3.0-or-later
// One scroll step's wait for its animation frame, apart from the DOM so it
// can be tested on its own.

/**
 * The frame timestamp for one scroll step, from `next` (which resolves with
 * the next frame's timestamp, or null at its time limit). It waits up to
 * `waitMs`, then `graceMs` more: a renderer kept busy past the limit lets the
 * timer run before its frame, and that frame then comes within the grace, so
 * a late frame still counts. Null only when no frame came in either wait.
 */
export async function stepStamp(
  next: (timeoutMs: number) => Promise<number | null>,
  waitMs: number,
  graceMs: number,
): Promise<number | null> {
  return (await next(waitMs)) ?? (await next(graceMs));
}
