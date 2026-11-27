// SPDX-License-Identifier: AGPL-3.0-or-later
// The newest open of each window, while any of its opens is under way in
// core. An open is stale once a newer one of its window has come in. A
// window's entry goes when its last open ends: main sends a window's opens
// in order, so none older can come after that.

interface Window {
  newest: number;
  active: number;
}

export class OpenTracker {
  private readonly windows = new Map<number, Window>();

  /** Starts an open; `end` must be called once it is over, however it ends. */
  begin(lane: number, openId: number): { stale: () => boolean; end: () => void } {
    const win = this.windows.get(lane) ?? { newest: 0, active: 0 };
    win.newest = Math.max(win.newest, openId);
    win.active += 1;
    this.windows.set(lane, win);
    let ended = false;
    return {
      stale: () => win.newest > openId,
      end: () => {
        if (ended) return;
        ended = true;
        win.active -= 1;
        if (win.active === 0 && this.windows.get(lane) === win) this.windows.delete(lane);
      },
    };
  }

  /** How many windows have an open under way. */
  get size(): number {
    return this.windows.size;
  }
}
