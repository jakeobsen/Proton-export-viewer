// SPDX-License-Identifier: AGPL-3.0-or-later
// The descriptors core opens for phase 2's body jobs. Core opens each message
// file itself and lends the descriptor to a pool thread, so that the file is
// closed whatever happens to the job: at once after a reply, or after a
// refusal before any thread took the job; after the thread's exit when the
// thread was ended mid-read (a timeout, a crash, a stop), because a read it
// had under way finishes before that exit and must not land on a descriptor
// number reused in between.
//
// Every descriptor counts from the start of its open until it is closed:
// opens still under way, files in jobs, and files a thread ended mid-read may
// still be reading. Past `max`, no new open starts until one is closed, so
// repeated timeouts on a slow disk can't pile descriptors up. A thread stuck
// in a syscall that never returns keeps its file open until it returns; at
// most `max` files are held that way.

import { close } from 'node:fs';

/** How an open ended: the descriptor, or why there is none. */
export type BodyOpen = { fd: number } | 'timeout' | 'stopped';

export class BodyFiles {
  private held = 0;
  private stopped = false;
  /** Opens waiting for a free slot, and opens under way: told when the files stop. */
  private readonly waiting = new Set<() => void>();
  private readonly onStop = new Set<() => void>();
  private readonly emptied: Array<() => void> = [];

  constructor(private readonly max: number) {}

  /** Descriptors held now, with the opens under way. */
  get count(): number {
    return this.held;
  }

  /**
   * Opens a file once fewer than `max` are held, within `ms`. Resolves with
   * the descriptor, which the caller then hands to `close`; with 'timeout'
   * when the open took longer; with 'stopped' after `stop`. An open that
   * completes after its caller gave up is closed as soon as it does. A
   * refused open rejects as `open` did.
   */
  async open(open: () => Promise<number>, ms: number): Promise<BodyOpen> {
    while (this.held >= this.max && !this.stopped) {
      await new Promise<void>((resolve) => this.waiting.add(resolve));
    }
    if (this.stopped) return 'stopped';
    this.held += 1;
    return new Promise<BodyOpen>((resolve, reject) => {
      let settled = false;
      const settle = (): boolean => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        this.onStop.delete(stop);
        return true;
      };
      const stop = (): void => {
        if (settle()) resolve('stopped');
      };
      const timer = setTimeout(() => {
        if (settle()) resolve('timeout');
      }, ms);
      this.onStop.add(stop);
      let attempt: Promise<number>;
      try {
        attempt = open();
      } catch (err) {
        attempt = Promise.reject(err);
      }
      attempt.then(
        (fd) => {
          if (settle()) resolve({ fd });
          else this.close(fd);
        },
        (err: unknown) => {
          this.free();
          if (settle()) reject(err);
        },
      );
    });
  }

  /**
   * Closes a descriptor `open` gave, once `after` has settled, or at once
   * without it. Its slot is free once the close has completed.
   */
  close(fd: number, after?: Promise<void>): void {
    const run = (): void => close(fd, () => this.free());
    if (after) void after.then(run, run);
    else run();
  }

  /** No new open starts, and opens that wait for a slot or are under way give up. */
  stop(): void {
    this.stopped = true;
    for (const stop of [...this.onStop]) stop();
    this.wake();
  }

  /** Resolves once every descriptor is closed and every open has ended. */
  async drain(): Promise<void> {
    while (this.held > 0) await new Promise<void>((resolve) => this.emptied.push(resolve));
  }

  private free(): void {
    this.held -= 1;
    this.wake();
    if (this.held === 0) for (const resolve of this.emptied.splice(0)) resolve();
  }

  private wake(): void {
    const waiting = [...this.waiting];
    this.waiting.clear();
    for (const resolve of waiting) resolve();
  }
}
