// SPDX-License-Identifier: AGPL-3.0-or-later
// The open export's recent searches, as main sends them to core: one
// first-in, first-out queue of recordings, reads and wipes. Each job is made
// for the stamp (source and generation) it was received under, and is sent
// only once that activation's index is open, after the job before it was
// answered. A generation bump settles every job of an older stamp at once.
//
// A wipe owed by a source (its switch was turned off, and no wipe has
// committed since) is saved in the registry. While one is owed the source's
// recent searches are closed: a read answers no entries without asking core,
// and a recording is never sent. Only a committed wipe that is the last one
// enqueued for the source clears it, and the clear is saved before the next
// job is sent.

import type { CoreResult } from '../../shared/core-protocol';
import type { Logger } from '../../shared/log/writer';
import { parseRecent, type RecentJob } from '../../shared/recent-search';
import type { SearchSpec } from '../../shared/search-chips';
import { sameStamp, type Stamp } from '../../shared/sources';

/** How a wipe ended: committed, refused or failed in core, or settled at a generation bump. */
export type WipeOutcome = 'ok' | 'failed' | 'stale';

type Job = { stamp: Stamp } & (
  | { kind: 'record'; q: string; at: number }
  | { kind: 'list'; done: (entries: SearchSpec[]) => void }
  | { kind: 'wipe'; seq: number; done: (outcome: WipeOutcome) => void }
);

export interface RecentJobsDeps {
  log: Logger;
  /** The current generation. */
  generation(): number;
  /** Sends one job to the running core of this stamp; rejects if that core isn't there. */
  send(stamp: Stamp, job: RecentJob): Promise<CoreResult>;
  /** The source's "Keep recent searches" switch: absent means on. */
  keeps(sourceKey: string): boolean;
  /** Whether the source owes a wipe that hasn't committed. */
  owes(sourceKey: string): boolean;
  /** Saves, synchronously, that the source owes no wipe. */
  clearOwed(sourceKey: string): void;
}

/** Where the open activation's index stands, for the queue. */
type IndexState = 'waiting' | 'ready' | 'none';

export class RecentJobs {
  private readonly queue: Job[] = [];
  private current: { stamp: Stamp; index: IndexState } | null = null;
  /** Per source, the sequence number of the last wipe enqueued. */
  private readonly lastWipe = new Map<string, number>();
  private wipeSeq = 0;
  private pumping = false;
  /** Moves on at each settle, so a pump waiting on an older answer stops there. */
  private epoch = 0;

  constructor(private readonly deps: RecentJobsDeps) {}

  /** A source became active under this stamp; its index isn't open yet. */
  activated(stamp: Stamp): void {
    this.settle();
    this.current = { stamp: { ...stamp }, index: 'waiting' };
  }

  /** No source is active. */
  deactivated(): void {
    this.current = null;
    this.settle();
  }

  /** The activation's index is open: its jobs can go to core. */
  ready(stamp: Stamp): void {
    if (!this.current || !sameStamp(this.current.stamp, stamp)) return;
    this.current.index = 'ready';
    void this.pump();
  }

  /** The activation has no index (none yet, or it couldn't open): its jobs end now. */
  noIndex(stamp: Stamp): void {
    if (!this.current || !sameStamp(this.current.stamp, stamp)) return;
    this.current.index = 'none';
    void this.pump();
  }

  /**
   * Records a committed search, received under `stamp` at `at`. Dropped
   * here if the switch is off, or if a wipe is owed and none is queued to
   * pay it; otherwise queued behind everything received before it.
   */
  record(stamp: Stamp, q: string, at: number): void {
    this.settle();
    const src = stamp.sourceKey;
    if (!this.deps.keeps(src)) return this.dropped(src, 'off');
    if (this.deps.owes(src) && !this.wipeQueued(src)) return this.dropped(src, 'wipe_owed');
    if (!this.isCurrent(stamp)) return this.dropped(src, 'stale');
    this.queue.push({ stamp: { ...stamp }, kind: 'record', q, at });
    void this.pump();
  }

  /**
   * The source's recent searches, newest first. None, without asking core,
   * while the switch is off or a wipe is owed; otherwise read after every
   * job received before it.
   */
  list(stamp: Stamp): Promise<SearchSpec[]> {
    this.settle();
    const src = stamp.sourceKey;
    if (!this.deps.keeps(src) || this.deps.owes(src) || !this.isCurrent(stamp)) {
      return Promise.resolve([]);
    }
    return new Promise((done) => {
      this.queue.push({ stamp: { ...stamp }, kind: 'list', done });
      void this.pump();
    });
  }

  /** Deletes every recent search of the source, after every job received before it. */
  wipe(stamp: Stamp): Promise<WipeOutcome> {
    this.settle();
    if (!this.isCurrent(stamp)) return Promise.resolve('stale');
    const src = stamp.sourceKey;
    this.wipeSeq += 1;
    const seq = this.wipeSeq;
    this.lastWipe.set(src, seq);
    return new Promise((done) => {
      this.queue.push({ stamp: { ...stamp }, kind: 'wipe', seq, done });
      void this.pump();
    });
  }

  /**
   * Settles, at once, every job made under an older generation than the
   * current one: a recording is dropped, a read finds no entries, and a wipe
   * is stale (an owed one stays saved, for the next activation).
   */
  settle(): void {
    const generation = this.deps.generation();
    if (this.current && this.current.stamp.generation !== generation) this.current = null;
    let removed = false;
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      const job = this.queue[i]!;
      if (job.stamp.generation === generation) continue;
      this.queue.splice(i, 1);
      this.end(job, 'stale');
      removed = true;
    }
    if (removed) {
      this.epoch += 1;
      this.pumping = false;
      void this.pump();
    }
  }

  /** Jobs waiting or in flight; for tests. */
  get size(): number {
    return this.queue.length;
  }

  private isCurrent(stamp: Stamp): boolean {
    return (
      !!this.current &&
      sameStamp(this.current.stamp, stamp) &&
      stamp.generation === this.deps.generation()
    );
  }

  private wipeQueued(src: string): boolean {
    return this.queue.some((job) => job.kind === 'wipe' && job.stamp.sourceKey === src);
  }

  private dropped(src: string, reason: 'off' | 'stale' | 'wipe_owed' | 'unavailable'): void {
    this.deps.log.info('recent.dropped', { reason }, { src });
  }

  /** Ends a job that won't reach core, or whose answer is no use: stale, or failed. */
  private end(job: Job, how: 'stale' | 'failed'): void {
    switch (job.kind) {
      case 'record':
        this.dropped(job.stamp.sourceKey, how === 'stale' ? 'stale' : 'unavailable');
        return;
      case 'list':
        job.done([]);
        return;
      case 'wipe':
        if (how === 'failed') {
          this.deps.log.warn('recent.wipe_failed', {}, { src: job.stamp.sourceKey });
        }
        job.done(how);
        return;
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    const epoch = this.epoch;
    try {
      while (this.queue.length > 0 && epoch === this.epoch) {
        const job = this.queue[0]!;
        const current = this.current;
        if (!this.isCurrent(job.stamp) || !current) {
          this.queue.shift();
          this.end(job, 'stale');
          continue;
        }
        if (current.index === 'waiting') return;
        const src = job.stamp.sourceKey;
        if (current.index === 'none') {
          this.queue.shift();
          this.end(job, 'failed');
          continue;
        }
        // The gate: nothing is read or recorded while a wipe is owed.
        if (job.kind !== 'wipe' && this.deps.owes(src)) {
          this.queue.shift();
          if (job.kind === 'record') this.dropped(src, 'wipe_owed');
          else job.done([]);
          continue;
        }
        let result: CoreResult;
        try {
          result = await this.deps.send(job.stamp, toCore(job));
        } catch {
          // No core for this stamp: the job stays at the head, unsent, until
          // the generation bump settles it.
          return;
        }
        // Settled meanwhile, at a bump.
        if (epoch !== this.epoch || this.queue[0] !== job) return;
        this.queue.shift();
        this.answer(job, result);
      }
    } finally {
      if (epoch === this.epoch) this.pumping = false;
    }
  }

  /** Core's answer to the job at the head. Runs before the next job is sent. */
  private answer(job: Job, result: CoreResult): void {
    const src = job.stamp.sourceKey;
    if (!result.ok) {
      this.end(job, 'failed');
      return;
    }
    switch (job.kind) {
      case 'record':
        return;
      case 'list': {
        // The switch went off, or a wipe became owed, while the read was in
        // core: the gate is closed now, so its rows are never shown.
        if (!this.deps.keeps(src) || this.deps.owes(src)) {
          job.done([]);
          return;
        }
        const rows = result.recent?.op === 'list' ? result.recent.rows : [];
        job.done(rows.map((row) => parseRecent(row.q)).filter((s): s is SearchSpec => s !== null));
        return;
      }
      case 'wipe':
        if (result.recent?.op !== 'wipe') {
          this.end(job, 'failed');
          return;
        }
        // Only the last wipe enqueued pays what is owed; it is saved before the next job goes.
        if (this.lastWipe.get(src) === job.seq && this.deps.owes(src)) this.deps.clearOwed(src);
        job.done('ok');
        return;
    }
  }
}

function toCore(job: Job): RecentJob {
  switch (job.kind) {
    case 'record':
      return { op: 'record', q: job.q, at: job.at };
    case 'list':
      return { op: 'list' };
    case 'wipe':
      return { op: 'wipe' };
  }
}
