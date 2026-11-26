// SPDX-License-Identifier: AGPL-3.0-or-later
// The reader lane: one dedicated worker that builds message bodies, one job at
// a time. Each job has a wall-clock limit from the moment it reaches the
// worker, and the worker runs with a heap limit. A job that breaches either
// ends the worker; the job fails with the reason, and a new worker is spawned
// for the jobs that follow. A worker that a job left holding a lot of memory
// is ended after the job, and replaced, so that memory goes back.

import type { HeapInfo } from 'node:v8';
import type { Worker } from 'node:worker_threads';

/** Every job gets this long, from the moment it reaches the worker. */
export const READER_TIMEOUT_MS = 3000;
/** The reader worker's old-generation heap limit. */
export const READER_HEAP_MB = 512;
/** A reader worker that holds more than this after a job is replaced. */
export const READER_RETIRE_MB = 256;

export type Breach = 'timeout' | 'limit';
export type JobFailure = Breach | 'crash' | 'superseded';
export type JobOutcome<T> = { ok: true; message: T } | { ok: false; reason: JobFailure };

export interface LaneMessage {
  type: string;
  reqId?: number;
}

export interface LaneOptions<Out extends LaneMessage> {
  /** Starts a worker with the given heap limit. */
  spawn: (heapMb: number) => Worker;
  timeoutMs?: number;
  heapMb?: number;
  /** A worker message that answers no job or call, such as a log line. */
  onOther?: (message: Out) => void;
  onSpawn?: () => void;
  /**
   * A worker exited. `planned` is true when the lane ended a sound worker on
   * purpose: replaced after a job, for new limits, or when the lane stopped.
   */
  onExit?: (exitCode: number, planned: boolean) => void;
  onError?: (err: unknown) => void;
  /** A job breached a limit; its worker is ended and replaced. */
  onBreach?: (breach: Breach, ms: number) => void;
  /**
   * Asked with each job's reply: true ends the worker once the reply is in,
   * and a new one takes over, as after a breach.
   */
  retire?: (message: Out) => boolean;
  /** A worker was ended after the job that this reply answers. */
  onRetire?: (message: Out) => void;
}

/** Whose job it is, and how new: a newer job of the same key supersedes an older one. */
export interface JobSlot {
  key: number;
  order: number;
}

interface Job<In, Out> {
  message: In;
  slot: JobSlot | null;
  resolve: (outcome: JobOutcome<Out>) => void;
}

interface Running<In, Out> extends Job<In, Out> {
  worker: Worker;
  started: number;
  timer: ReturnType<typeof setTimeout>;
}

interface WorkerState {
  breach: Breach | null;
  /** The lane ended this worker on purpose, not for a breach or a crash. */
  planned: boolean;
}

export class ReaderLane<In extends LaneMessage, Out extends LaneMessage> {
  private worker: Worker | null = null;
  private readonly states = new WeakMap<Worker, WorkerState>();
  private readonly queue: Array<Job<In, Out>> = [];
  private running: Running<In, Out> | null = null;
  private readonly calls = new Map<number, { worker: Worker; resolve: (m: Out | null) => void }>();
  private heapMb: number;
  private timeoutMs: number;
  private stopped = false;

  constructor(private readonly options: LaneOptions<Out>) {
    this.heapMb = options.heapMb ?? READER_HEAP_MB;
    this.timeoutMs = options.timeoutMs ?? READER_TIMEOUT_MS;
  }

  /** Spawns the worker now instead of on first use. */
  start(): void {
    this.ensureWorker();
  }

  /**
   * Queues a job. Of the jobs with the same slot key, only the newest by order
   * waits: a job fails as superseded at once if a newer one of its key is
   * queued or running, and it drops the older ones still queued. A running job
   * is left to finish.
   */
  job(message: In, slot: JobSlot | null = null): Promise<JobOutcome<Out>> {
    return new Promise((resolve) => {
      if (this.stopped) {
        resolve({ ok: false, reason: 'crash' });
        return;
      }
      if (slot) {
        const newer = (job: Job<In, Out> | null) =>
          job?.slot?.key === slot.key && job.slot.order > slot.order;
        if (newer(this.running) || this.queue.some(newer)) {
          resolve({ ok: false, reason: 'superseded' });
          return;
        }
        for (let i = this.queue.length - 1; i >= 0; i -= 1) {
          const queued = this.queue[i];
          if (queued?.slot?.key === slot.key) {
            this.queue.splice(i, 1);
            queued.resolve({ ok: false, reason: 'superseded' });
          }
        }
      }
      this.queue.push({ message, slot, resolve });
      this.pump();
    });
  }

  /** Sends a request outside the job queue and waits for the reply with its reqId. */
  call(message: In & { reqId: number }): Promise<Out | null> {
    const worker = this.ensureWorker();
    if (!worker) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.calls.set(message.reqId, { worker, resolve });
      worker.postMessage(message);
    });
  }

  /** Sends a message outside the job queue that expects no reply. */
  post(message: In): void {
    this.ensureWorker()?.postMessage(message);
  }

  /** Test builds: replaces the limits; the current worker ends and the next one uses them. */
  async setLimits(limits: { heapMb?: number; timeoutMs?: number }): Promise<void> {
    if (limits.heapMb !== undefined) this.heapMb = limits.heapMb;
    if (limits.timeoutMs !== undefined) this.timeoutMs = limits.timeoutMs;
    const worker = this.worker;
    if (worker) {
      this.worker = null;
      this.endPlanned(worker);
      await worker.terminate();
    }
  }

  get queued(): number {
    return this.queue.length;
  }

  /** The current worker's thread id and limits, as the worker itself was started with, and the jobs waiting. */
  describe(): {
    threadId: number | null;
    heapMb: number | null;
    timeoutMs: number;
    queued: number;
  } {
    return {
      threadId: this.worker?.threadId ?? null,
      heapMb: this.worker?.resourceLimits?.maxOldGenerationSizeMb ?? null,
      timeoutMs: this.timeoutMs,
      queued: this.queue.length,
    };
  }

  /**
   * The current worker's heap statistics, or null when there is no worker, or
   * it has ended or ends before it answers. A worker that ran out of heap is
   * still the current one until its exit event, and refuses the request. For
   * measurements.
   */
  heapStatistics(): Promise<HeapInfo | null> {
    const worker = this.worker;
    if (!worker) return Promise.resolve(null);
    return new Promise((resolve) => {
      const ended = () => resolve(null);
      worker.once('exit', ended);
      worker
        .getHeapStatistics()
        .then(resolve, () => resolve(null))
        .finally(() => worker.off('exit', ended));
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const job of this.queue.splice(0)) job.resolve({ ok: false, reason: 'crash' });
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      this.endPlanned(worker);
      await worker.terminate();
    }
  }

  private ensureWorker(): Worker | null {
    if (this.stopped) return null;
    if (this.worker) return this.worker;
    const worker = this.options.spawn(this.heapMb);
    const state: WorkerState = { breach: null, planned: false };
    this.states.set(worker, state);
    this.worker = worker;
    this.options.onSpawn?.();
    worker.on('message', (message: Out) => this.onMessage(worker, message));
    worker.on('error', (err: NodeJS.ErrnoException) => {
      if (err?.code === 'ERR_WORKER_OUT_OF_MEMORY' && state.breach === null) state.breach = 'limit';
      this.options.onError?.(err);
    });
    worker.on('exit', (code) => this.onExit(worker, state, code));
    return worker;
  }

  private onMessage(worker: Worker, message: Out): void {
    const running = this.running;
    if (running && running.worker === worker && message.reqId === running.message.reqId) {
      if (this.options.retire?.(message)) this.retire(worker, message);
      this.finish({ ok: true, message });
      return;
    }
    const call = message.reqId === undefined ? undefined : this.calls.get(message.reqId);
    if (call && call.worker === worker && message.reqId !== undefined) {
      this.calls.delete(message.reqId);
      call.resolve(message);
      return;
    }
    this.options.onOther?.(message);
  }

  private onExit(worker: Worker, state: WorkerState, code: number): void {
    if (this.worker === worker) this.worker = null;
    this.options.onExit?.(code, state.planned);
    const running = this.running;
    if (running && running.worker === worker) {
      const reason: JobFailure = state.breach ?? 'crash';
      if (state.breach) this.options.onBreach?.(state.breach, Date.now() - running.started);
      this.finish({ ok: false, reason });
    }
    for (const [reqId, call] of this.calls) {
      if (call.worker !== worker) continue;
      this.calls.delete(reqId);
      call.resolve(null);
    }
    // A breach was the job's doing, not the worker's: have the next one ready.
    if (state.breach) this.ensureWorker();
    this.pump();
  }

  /** Ends a worker after its job, and has the next one ready. */
  private retire(worker: Worker, message: Out): void {
    if (this.worker === worker) this.worker = null;
    this.endPlanned(worker);
    this.options.onRetire?.(message);
    void worker.terminate();
    this.ensureWorker();
  }

  /** Marks a worker the lane is about to end on purpose. */
  private endPlanned(worker: Worker): void {
    const state = this.states.get(worker);
    if (state) state.planned = true;
  }

  private finish(outcome: JobOutcome<Out>): void {
    const running = this.running;
    if (!running) return;
    clearTimeout(running.timer);
    this.running = null;
    running.resolve(outcome);
    this.pump();
  }

  private pump(): void {
    if (this.running || this.queue.length === 0) return;
    const worker = this.ensureWorker();
    const job = this.queue.shift();
    if (!worker || !job) {
      job?.resolve({ ok: false, reason: 'crash' });
      return;
    }
    const state = this.states.get(worker);
    const timer = setTimeout(() => {
      if (this.running?.worker !== worker || !state) return;
      if (state.breach === null) state.breach = 'timeout';
      if (this.worker === worker) this.worker = null;
      void worker.terminate();
    }, this.timeoutMs);
    this.running = { ...job, worker, started: Date.now(), timer };
    worker.postMessage(job.message);
  }
}
