// SPDX-License-Identifier: AGPL-3.0-or-later
// The index's threads as seen from core: request/response calls with an
// optional wall-clock limit. A call past its limit terminates the thread and
// starts a new one in its place; the call fails with TIMEOUT. A call a thread
// took and lost says when that thread has exited, so a caller that lent it a
// file descriptor knows when nothing can read it any more. The index pool
// runs jobs on its threads, first come first served.

import type { Worker } from 'node:worker_threads';

export type ThreadRole = 'writer' | 'query' | 'parse' | 'verify';

export interface ThreadRequest {
  id: number;
  op: string;
  args: unknown;
}

export interface ThreadReply {
  id: number;
  ok: boolean;
  data?: unknown;
  error?: string;
}

/** What the index needs of a thread; tests run the operations in process instead. */
export interface IndexThread {
  /**
   * Runs one operation. A call the thread took and then lost (TIMEOUT,
   * THREAD_EXIT, THREAD_STOPPED) fails with a ThreadError whose `exited`
   * resolves once that thread has exited, with nothing of the call still
   * running; a call refused before any thread took it has no `exited`.
   */
  call<T>(op: string, args?: unknown, timeoutMs?: number): Promise<T>;
  stop(): Promise<void>;
  /** How many times the thread was replaced after a breach or a crash. */
  readonly respawns: number;
  /** Called with each new thread after a breach or a crash replaced the old one. */
  onRespawn: (() => void) | null;
}

export class ThreadError extends Error {
  constructor(
    readonly code: string,
    /** For a call a thread took and lost: resolves once that thread has exited. */
    readonly exited?: Promise<void>,
  ) {
    super(code);
  }
}

export const TIMEOUT = 'TIMEOUT';
export const THREAD_EXIT = 'THREAD_EXIT';
export const THREAD_STOPPED = 'THREAD_STOPPED';

/** One worker thread. A breach or a crash replaces it with a new one. */
export class WorkerThread implements IndexThread {
  private worker: Worker | null;
  private seq = 0;
  private readonly pending = new Map<
    number,
    { resolve: (r: ThreadReply) => void; reject: (e: Error) => void; worker: Worker }
  >();
  /** Each worker's exit, whether or not it is still the current one. */
  private readonly exits = new WeakMap<Worker, Promise<void>>();
  respawns = 0;
  onRespawn: (() => void) | null = null;

  constructor(private readonly spawnWorker: () => Worker) {
    this.worker = this.spawn();
  }

  private spawn(): Worker {
    const w = this.spawnWorker();
    this.exits.set(w, new Promise<void>((resolve) => w.once('exit', () => resolve())));
    w.on('message', (r: ThreadReply) => {
      if (this.worker !== w) return;
      const p = this.pending.get(r.id);
      if (!p) return;
      this.pending.delete(r.id);
      p.resolve(r);
    });
    w.on('error', () => {
      // The exit that follows replaces the thread.
    });
    w.on('exit', () => {
      if (this.worker !== w) return;
      this.failAll(THREAD_EXIT);
      this.replace();
    });
    return w;
  }

  private failAll(code: string): void {
    const waiting = [...this.pending.values()];
    this.pending.clear();
    // Each call says when the worker it was sent to has gone, even after a replacement.
    for (const p of waiting) p.reject(new ThreadError(code, this.exits.get(p.worker)));
  }

  private replace(): void {
    this.worker = this.spawn();
    this.respawns += 1;
    this.onRespawn?.();
  }

  async call<T>(op: string, args: unknown = {}, timeoutMs = 0): Promise<T> {
    const worker = this.worker;
    if (!worker) throw new ThreadError(THREAD_STOPPED);
    this.seq += 1;
    const id = this.seq;
    const reply = await new Promise<ThreadReply>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      this.pending.set(id, {
        resolve: (r) => {
          if (timer) clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        },
        worker,
      });
      worker.postMessage({ id, op, args } satisfies ThreadRequest);
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (!this.pending.has(id) || this.worker !== worker) return;
          // Everything on this thread is lost with it.
          this.failAll(TIMEOUT);
          this.replace();
          void worker.terminate();
        }, timeoutMs);
      }
    });
    if (!reply.ok) throw new ThreadError(reply.error ?? 'FAILED');
    return reply.data as T;
  }

  async stop(): Promise<void> {
    const w = this.worker;
    this.worker = null;
    this.failAll(THREAD_STOPPED);
    if (w) await w.terminate();
  }
}

/** Runs jobs on a set of threads, first come first served. */
export class Pool {
  private readonly idle: IndexThread[];
  private readonly queue: Array<{
    resolve: (thread: IndexThread) => void;
    reject: (err: Error) => void;
  }> = [];
  private stopped = false;

  constructor(readonly threads: IndexThread[]) {
    this.idle = [...threads];
  }

  get respawns(): number {
    return this.threads.reduce((n, t) => n + t.respawns, 0);
  }

  async run<T>(op: string, args: unknown, timeoutMs: number): Promise<T> {
    if (this.stopped) throw new ThreadError(THREAD_STOPPED);
    const thread =
      this.idle.pop() ??
      (await new Promise<IndexThread>((resolve, reject) => this.queue.push({ resolve, reject })));
    try {
      return await thread.call<T>(op, args, timeoutMs);
    } finally {
      const next = this.queue.shift();
      if (next) next.resolve(thread);
      else this.idle.push(thread);
    }
  }

  /** Ends every thread; jobs waiting for one fail, and no new job starts. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const waiting of this.queue.splice(0)) waiting.reject(new ThreadError(THREAD_STOPPED));
    await Promise.all(this.threads.map((t) => t.stop()));
  }
}
