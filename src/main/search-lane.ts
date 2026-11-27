// SPDX-License-Identifier: AGPL-3.0-or-later
// Searches while the user types. A search can't be stopped once core runs it,
// so each window has at most one search in core and one waiting; a newer
// request takes the waiting one's place, and that one is answered as
// superseded without running.

export const SUPERSEDED = Symbol('superseded');
export type Superseded = typeof SUPERSEDED;

interface Waiting {
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

interface Lane {
  running: boolean;
  waiting: Waiting | null;
}

export class SearchLanes<W extends object> {
  private readonly lanes = new WeakMap<W, Lane>();

  /** Runs `task` for the window now, or after the one in core, unless a newer one replaces it. */
  run<T>(win: W, task: () => Promise<T>): Promise<T | Superseded> {
    let lane = this.lanes.get(win);
    if (!lane) {
      lane = { running: false, waiting: null };
      this.lanes.set(win, lane);
    }
    if (!lane.running) return this.start(lane, task);
    return new Promise<T | Superseded>((resolve, reject) => {
      lane.waiting?.resolve(SUPERSEDED);
      lane.waiting = { task, resolve: resolve as (value: unknown) => void, reject };
    });
  }

  /** True while the window has a search in core. */
  busy(win: W): boolean {
    return this.lanes.get(win)?.running ?? false;
  }

  private async start<T>(lane: Lane, task: () => Promise<T>): Promise<T> {
    lane.running = true;
    try {
      return await task();
    } finally {
      lane.running = false;
      const next = lane.waiting;
      lane.waiting = null;
      if (next) this.start(lane, next.task).then(next.resolve, next.reject);
    }
  }
}
