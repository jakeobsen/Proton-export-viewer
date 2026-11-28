// SPDX-License-Identifier: AGPL-3.0-or-later
// Searches while the user types. A search can't be stopped once core runs it,
// so each window has at most one search in core and one waiting; a newer
// request takes the waiting one's place, and that one is answered as
// superseded without running. Requests can also come from several
// requesters, each with its own waiting place: a newer request then takes
// only its own requester's place, so no requester can keep another's request
// from running.

export const SUPERSEDED = Symbol('superseded');
export type Superseded = typeof SUPERSEDED;

interface Waiting {
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

interface Lane {
  running: boolean;
  /** The waiting request of each requester, in the order their places were taken. */
  waiting: Map<string, Waiting>;
}

export class SearchLanes<W extends object> {
  private readonly lanes = new WeakMap<W, Lane>();

  /**
   * Runs `task` for the window now, or after the one in core, unless a newer
   * one from the same requester replaces it.
   */
  run<T>(win: W, task: () => Promise<T>, requester = ''): Promise<T | Superseded> {
    let lane = this.lanes.get(win);
    if (!lane) {
      lane = { running: false, waiting: new Map() };
      this.lanes.set(win, lane);
    }
    if (!lane.running) return this.start(lane, task);
    const waiting = lane.waiting;
    return new Promise<T | Superseded>((resolve, reject) => {
      waiting.get(requester)?.resolve(SUPERSEDED);
      // A replacement keeps its requester's place in the order.
      waiting.set(requester, { task, resolve: resolve as (value: unknown) => void, reject });
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
      const first = lane.waiting.entries().next();
      if (!first.done) {
        const [requester, next] = first.value;
        lane.waiting.delete(requester);
        this.start(lane, next.task).then(next.resolve, next.reject);
      }
    }
  }
}
