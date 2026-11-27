// SPDX-License-Identifier: AGPL-3.0-or-later
// Spaces out the opens of one window's body frame. Chromium silently stops
// following a frame's navigations past 200 in 10 seconds, so a held arrow key
// could leave the frame behind the selection. Each open waits until at least
// OPEN_GAP_MS after the window's previous one started; of the opens waiting,
// only the newest goes ahead, and the others end as superseded.

/** The least time between the starts of two opens in one window: at most 167 in 10 s. */
export const OPEN_GAP_MS = 60;

interface Waiting {
  timer: ReturnType<typeof setTimeout>;
  resolve: (go: boolean) => void;
}

interface Lane {
  last: number;
  waiting: Waiting | null;
}

export class OpenPacer<W extends object> {
  private readonly lanes = new WeakMap<W, Lane>();

  constructor(
    private readonly gapMs: number = OPEN_GAP_MS,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /**
   * Resolves true when this window's open may start, or false as soon as a
   * newer open of the window takes its place.
   */
  turn(win: W): Promise<boolean> {
    let lane = this.lanes.get(win);
    if (!lane) {
      lane = { last: -Infinity, waiting: null };
      this.lanes.set(win, lane);
    }
    const current = lane;
    if (current.waiting) {
      clearTimeout(current.waiting.timer);
      current.waiting.resolve(false);
      current.waiting = null;
    }
    const wait = current.last + this.gapMs - this.now();
    if (wait <= 0) {
      current.last = this.now();
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        current.waiting = null;
        current.last = this.now();
        resolve(true);
      }, wait);
      current.waiting = { timer, resolve };
    });
  }
}
