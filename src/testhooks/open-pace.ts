// SPDX-License-Identifier: AGPL-3.0-or-later
// The open bench's pace: each open starts at least OPEN_PACE_MS after the one
// before, on the monotonic clock.

/**
 * Opens start at least this far apart. Chromium drops a frame's navigations
 * past 200 in 10 s, so a faster loop would time navigations that never
 * happen. Main keeps the pace: a hidden window's timers are throttled.
 */
export const OPEN_PACE_MS = 60;

export interface PaceClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: PaceClock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Runs `open` for each item in turn, starting each at least OPEN_PACE_MS
 * after the start of the one before. A timer can fire a little early, so
 * the wait is in whole milliseconds and the clock is read again after it.
 */
export async function paced<T, R>(
  items: T[],
  open: (item: T) => Promise<R[]>,
  clock: PaceClock = realClock,
): Promise<R[]> {
  const out: R[] = [];
  let last = -Infinity;
  for (const item of items) {
    for (let wait = last + OPEN_PACE_MS - clock.now(); wait > 0;) {
      await clock.sleep(Math.ceil(wait));
      wait = last + OPEN_PACE_MS - clock.now();
    }
    last = clock.now();
    out.push(...(await open(item)));
  }
  return out;
}
