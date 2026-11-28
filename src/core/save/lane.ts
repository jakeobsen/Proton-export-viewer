// SPDX-License-Identifier: AGPL-3.0-or-later
// Core's save lane: one save at a time, apart from the reader lane, so a large
// save never holds up reading.
//
// A save starts with a file core opened for it, checked to be the file the
// view was read from: the same device and inode, and the same size and time.
// A worker of its own reads it, and hands over one chunk at a time; it makes
// the next only once main has taken the last, so a save holds at most one
// chunk here and one in the worker. The chunk that completes the save goes to
// main only after the file's size and time are checked again.
//
// The descriptor is core's, and is closed only after the worker has exited: a
// worker still reading must never read a file that got the same number.

import type { FileVersion } from '../../shared/reader-protocol';
import {
  SAVE_IDLE_MS,
  type SaveFailure,
  type SaveTarget,
  type SaveWorkerIn,
  type SaveWorkerOut,
} from '../../shared/save-protocol';

/** The part of a worker thread the lane uses. */
export interface SaveWorker {
  postMessage(message: SaveWorkerIn): void;
  on(event: 'message', listener: (message: SaveWorkerOut) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  once(event: 'exit', listener: (code: number) => void): unknown;
  terminate(): Promise<number>;
}

/** A message file core opened for a save. */
export interface SaveFile {
  fd: number;
  /** Closes the descriptor. Called once, after the worker has exited. */
  close(): void;
}

export interface SaveLaneOptions {
  spawn: () => SaveWorker;
  /** The file's size and modification time now. */
  version: (fd: number) => FileVersion;
  idleMs?: number;
  /** Logs what the worker reports: a fixed code, and fields the log schema checks. */
  log?: (level: 'error' | 'warn' | 'info', code: string, data?: Record<string, unknown>) => void;
  /** Test builds only: waits before the chunk that completes a save goes out. */
  beforeLast?: () => Promise<void>;
}

/** The answer to a pull: the next bytes, and whether they complete the save; or why it failed. */
export type Pulled =
  { ok: true; chunk: Uint8Array; done: boolean } | { ok: false; code: SaveFailure };

interface Active {
  saveId: number;
  file: SaveFile;
  version: FileVersion;
  worker: SaveWorker;
  exited: boolean;
  /** The chunk the worker made, not yet taken. */
  ready: Uint8Array | null;
  /** The bytes that complete the save, once the worker has them. */
  last: Uint8Array | null;
  failed: SaveFailure | null;
  /** A pull waiting for the worker. */
  waiter: ((pulled: Pulled) => void) | null;
  timer: ReturnType<typeof setTimeout> | null;
  ended: Promise<void>;
}

function sameVersion(a: FileVersion, b: FileVersion): boolean {
  return a.size === b.size && a.mtimeNs === b.mtimeNs;
}

export class SaveLane {
  private active: Active | null = null;
  /** How the last save that failed ended, for a pull that comes after. */
  private lastFailure: { saveId: number; code: SaveFailure } | null = null;

  constructor(private readonly options: SaveLaneOptions) {}

  get busy(): boolean {
    return this.active !== null;
  }

  /**
   * Starts a save of `file`, which must still have the size and time the view
   * saw. Resolves with the number of bytes the save will stream, or why not.
   * The lane owns `file` from here: it is closed whatever the outcome.
   */
  open(
    saveId: number,
    file: SaveFile,
    version: FileVersion,
    target: SaveTarget,
  ): { ok: true; size: number } | { ok: false; code: 'busy' | 'changed' | 'unreadable' } {
    if (this.active) {
      file.close();
      return { ok: false, code: 'busy' };
    }
    let now: FileVersion;
    try {
      now = this.options.version(file.fd);
    } catch {
      file.close();
      return { ok: false, code: 'unreadable' };
    }
    if (!sameVersion(now, version)) {
      file.close();
      return { ok: false, code: 'changed' };
    }
    const size = target.kind === 'eml' ? Number(version.size) : target.size;
    if (target.kind === 'eml') target = { kind: 'eml', size };
    let worker: SaveWorker;
    try {
      worker = this.options.spawn();
    } catch {
      file.close();
      return { ok: false, code: 'unreadable' };
    }
    let exited!: () => void;
    const active: Active = {
      saveId,
      file,
      version,
      worker,
      exited: false,
      ready: null,
      last: null,
      failed: null,
      waiter: null,
      timer: null,
      ended: new Promise<void>((resolve) => {
        exited = resolve;
      }),
    };
    worker.once('exit', () => {
      active.exited = true;
      file.close();
      if (this.active === active) this.fail(active, 'unreadable');
      exited();
    });
    worker.on('error', () => this.fail(active, 'unreadable'));
    worker.on('message', (message) => this.onWorker(active, message));
    this.active = active;
    this.touch(active);
    worker.postMessage({ type: 'start', fd: file.fd, fileSize: Number(version.size), target });
    return { ok: true, size };
  }

  /** The next chunk of save `saveId`; waits for the worker if it has none ready. */
  pull(saveId: number): Promise<Pulled> {
    const active = this.active;
    if (!active || active.saveId !== saveId) {
      const code = this.lastFailure?.saveId === saveId ? this.lastFailure.code : 'cancelled';
      return Promise.resolve({ ok: false, code });
    }
    // One pull at a time: a second one while the first waits is refused.
    if (active.waiter) return Promise.resolve({ ok: false, code: 'cancelled' });
    return new Promise<Pulled>((resolve) => {
      active.waiter = resolve;
      void this.answer(active);
    });
  }

  /** Ends save `saveId`, if it is the one running; resolves once its worker has exited. */
  async cancel(saveId: number): Promise<void> {
    const active = this.active;
    if (!active || active.saveId !== saveId) return;
    this.fail(active, 'cancelled');
    await active.ended;
  }

  /** Ends whatever save is running. */
  async stop(): Promise<void> {
    if (this.active) await this.cancel(this.active.saveId);
  }

  private onWorker(active: Active, message: SaveWorkerOut): void {
    if (this.active !== active) return;
    switch (message.type) {
      case 'chunk':
        active.ready = message.bytes;
        this.touch(active);
        void this.answer(active);
        return;
      case 'last':
        active.last = message.bytes;
        this.touch(active);
        void this.answer(active);
        return;
      case 'tick':
        this.touch(active);
        return;
      case 'failed':
        this.fail(active, message.reason);
        return;
      case 'log':
        this.options.log?.(message.level, message.code, message.data);
        return;
    }
  }

  /** Answers a waiting pull, if the worker has given what it needs. */
  private async answer(active: Active): Promise<void> {
    const waiter = active.waiter;
    if (!waiter || this.active !== active) return;
    if (active.ready) {
      const chunk = active.ready;
      active.ready = null;
      active.waiter = null;
      this.touch(active);
      active.worker.postMessage({ type: 'more' });
      waiter({ ok: true, chunk, done: false });
      return;
    }
    if (active.last) {
      const chunk = active.last;
      active.last = null;
      if (__PEV_TEST_HOOKS__ && this.options.beforeLast) await this.options.beforeLast();
      if (this.active !== active) return;
      let now: FileVersion | null;
      try {
        now = this.options.version(active.file.fd);
      } catch {
        now = null;
      }
      if (!now || !sameVersion(now, active.version)) {
        this.fail(active, 'changed');
        return;
      }
      active.waiter = null;
      this.end(active);
      waiter({ ok: true, chunk, done: true });
    }
  }

  /** Restarts the no-progress timer. */
  private touch(active: Active): void {
    if (active.timer) clearTimeout(active.timer);
    active.timer = setTimeout(
      () => this.fail(active, 'stalled'),
      this.options.idleMs ?? SAVE_IDLE_MS,
    );
  }

  private fail(active: Active, code: SaveFailure): void {
    if (this.active !== active) return;
    active.failed = code;
    this.lastFailure = { saveId: active.saveId, code };
    const waiter = active.waiter;
    active.waiter = null;
    this.end(active);
    waiter?.({ ok: false, code });
  }

  /** Leaves the lane free for the next save; the worker is ended and the file closed after it. */
  private end(active: Active): void {
    if (this.active !== active) return;
    this.active = null;
    if (active.timer) clearTimeout(active.timer);
    active.timer = null;
    active.ready = null;
    active.last = null;
    if (!active.exited) void active.worker.terminate().catch(() => undefined);
  }
}
