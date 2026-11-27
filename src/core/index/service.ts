// SPDX-License-Identifier: AGPL-3.0-or-later
// The open source's index in core. Core owns the database: a writer thread
// holds the only write connection and a query thread a read-only one (WAL lets
// it read while the writer writes). Every connection core opens is in the
// connection registry until it is closed or its thread ends.
//
// Phase 1 reads labels.json and every metadata file on the index pool, in the
// order the folder listed them, with a time limit per job, and writes them in
// batches of at most 1,000 pairs and 4 MiB of input. Pages read meanwhile
// hold the rows written so far. When phase 1 ends, the pool's threads end too;
// after a while without queries or writes, both connections release their
// caches.
//
// On reopen, phase 1 reconciles: the folder's files are compared with the
// stored pairs, what needs nothing read (a file gone, a message file changed)
// is applied first, and only new and changed metadata files are read.
// labels.json is read again only if it changed. Pages read meanwhile stay
// usable throughout.
//
// An index that was already there is checked once it is open: SQLite's quick
// check runs on its own read-only connection in a short-lived thread, while
// pages are read as usual. A failed check, or SQLite reporting the file as
// corrupt at any time, is reported once, for the source's lifecycle to act on.
// Closing is the index's part of the teardown: queued jobs are cancelled, the
// write in flight rolls back, the check is ended and joined, and every
// connection is closed.

import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type {
  IndexAnswer,
  IndexCondition,
  IndexOpened,
  IndexProgress,
  IndexQuery,
  SearchPage,
  SearchSnippets,
} from '../../shared/index-types';
import type { Logger } from '../../shared/log/writer';
import type { Stamp } from '../../shared/sources';
import type { FileRef, RunScan } from '../containment';
import { TXN_INPUT_BYTES, WRITE_BATCH_PAIRS } from './limits';
import type {
  ApplyResult,
  BatchResult,
  CheckResult,
  LabelsJobResult,
  MetaJobItem,
  MetaJobResult,
  WriterOpened,
} from './ops';
import {
  Pool,
  THREAD_STOPPED,
  ThreadError,
  TIMEOUT,
  type IndexThread,
  type ThreadRole,
} from './pool';
import { CAPPED, CAPPED_LISTS } from './schema';
import {
  labelsStatOf,
  type ApplyItem,
  type FileStat,
  type PairFiles,
  type Phase1Item,
  type ReconcilePlan,
} from './writer';

/** A metadata job's wall-clock limit. */
export const INDEX_JOB_MS = 10_000;
/** Metadata files per pool job. */
export const META_JOB = 50;
/** Index pool threads. */
export const POOL_SIZE = 2;
/** Batches parsed ahead of the writer, so parsed rows never pile up. */
export const BATCHES_AHEAD = 2;
/** Caches are released after this long without a query or a write. */
export const IDLE_MS = 20_000;
/** Progress is reported at most this often, and once more after the last change. */
export const PROGRESS_MS = 250;

/** One registered connection: which thread holds it, on which database. */
export interface Connection {
  role: 'writer' | 'query' | 'verifier';
  dbPath: string;
}

/**
 * Every database connection core holds, whichever index it belongs to.
 * Nothing in a database's family is deleted or reopened while one is listed
 * for it.
 */
export class ConnectionRegistry {
  private seq = 0;
  private readonly open = new Map<number, Connection>();

  /** Lists a connection; returns its entry, for `remove`. */
  add(connection: Connection): number {
    this.seq += 1;
    this.open.set(this.seq, { ...connection });
    return this.seq;
  }

  remove(entry: number | null): void {
    if (entry !== null) this.open.delete(entry);
  }

  list(): Connection[] {
    return [...this.open.values()].map((c) => ({ ...c }));
  }

  get size(): number {
    return this.open.size;
  }

  holds(dbPath: string): boolean {
    return [...this.open.values()].some((c) => c.dbPath === dbPath);
  }
}

export interface IndexOptions {
  poolSize?: number;
  jobMs?: number;
  metaJob?: number;
  idleMs?: number;
  /** A cap on the index's size on disk, with its WAL and shared memory; none by default. */
  capBytes?: number | null;
  /** Pairs per write transaction; at most the default. */
  batchPairs?: number;
  /** Builds with test hooks only: awaited before each phase 1 write. */
  beforeWrite?: () => Promise<void>;
  /**
   * Builds with test hooks only: read new metadata files in name order, and
   * write their batches in that order.
   */
  readByName?: boolean;
}

export interface IndexServiceDeps {
  /** `<userData>/index`. */
  indexDir: string;
  stamp: Stamp;
  /** The run folder, canonical. */
  root: string;
  log: Logger;
  /** Starts a thread of the given role. */
  thread: (role: ThreadRole) => IndexThread;
  /** False once the source's generation has moved on. */
  isCurrent: () => boolean;
  options?: IndexOptions;
  /** The folders of the exports the app knows, checked by the writer before it changes a file. */
  exportRoots?: string[];
  /** Core's registry of connections; the index's own one if none is given. */
  connections?: ConnectionRegistry;
  /** Called once, with the reason, when the index turns out to be damaged. */
  onDamage?: (reason: string) => void;
  /** Called with the outcome of the check of an existing index. */
  onChecked?: (result: CheckResult | null, ms: number) => void;
  /**
   * Called when `progress` changes: at once for its condition and phase, and
   * at most every PROGRESS_MS for its counts.
   */
  onChange?: () => void;
}

export interface OpenOptions {
  /** The index is made in place of a damaged one. */
  rebuild?: boolean;
}

const fileStat = (ref: FileRef): FileStat => ({
  rel: ref.rel,
  size: ref.size,
  mtimeNs: ref.mtimeNs,
  dev: ref.dev,
  ino: ref.ino,
});

/** Splits items into batches of at most `count` items and `bytes` bytes; a larger item goes alone. */
export function splitBatches<T>(
  items: T[],
  count: number,
  bytes: number,
  size: (item: T) => number,
): T[][] {
  const out: T[][] = [];
  let current: T[] = [];
  let total = 0;
  for (const item of items) {
    const n = size(item);
    if (current.length > 0 && (current.length >= count || total + n > bytes)) {
      out.push(current);
      current = [];
      total = 0;
    }
    current.push(item);
    total += n;
  }
  if (current.length > 0) out.push(current);
  return out;
}

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** The log reason for a pair's code. */
export function reasonOf(code: string): string {
  if (code.startsWith('FILE_')) return code.slice('FILE_'.length).toLowerCase();
  switch (code) {
    case 'META_JSON':
      return 'meta_json';
    case 'META_SHAPE':
      return 'meta_shape';
    case 'META_ID':
      return 'meta_id';
    case 'META_TIMEOUT':
      return 'timeout';
    default:
      return 'worker_failed';
  }
}

export class IndexService {
  readonly connections: ConnectionRegistry;
  readonly dbPath: string;
  private writer: IndexThread | null = null;
  private query: IndexThread | null = null;
  private verifier: IndexThread | null = null;
  private checking: Promise<void> | null = null;
  private writerEntry: number | null = null;
  private queryEntry: number | null = null;
  private queryReady: Promise<void> | null = null;
  private pool: Pool | null = null;
  private opened: WriterOpened | null = null;
  private running: Promise<void> | null = null;
  private lastActive = Date.now();
  private released = false;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private damaged = false;
  /** Shared with the writer thread: 1 stops the write in flight, which rolls back. */
  private readonly cancel = new SharedArrayBuffer(4);
  readonly progress: IndexProgress = {
    phase: 'opening',
    loaded: 0,
    total: 0,
    failed: 0,
    timeouts: 0,
    capped: 0,
    condition: 'ok',
  };
  private readonly poolSize: number;
  private readonly jobMs: number;
  private readonly metaJob: number;
  private readonly idleMs: number;
  private readonly capBytes: number | null;
  private readonly batchPairs: number;
  /** When progress was last reported, on the monotonic clock. */
  private lastReport = -Infinity;
  private reportTimer: ReturnType<typeof setTimeout> | null = null;
  private endClosing: () => void = () => {};
  /** Resolves when the teardown begins. */
  private readonly closing = new Promise<void>((resolve) => {
    this.endClosing = resolve;
  });

  constructor(private readonly deps: IndexServiceDeps) {
    this.dbPath = join(deps.indexDir, `${deps.stamp.sourceKey}.sqlite`);
    this.connections = deps.connections ?? new ConnectionRegistry();
    const o = deps.options ?? {};
    this.poolSize = o.poolSize ?? POOL_SIZE;
    this.jobMs = o.jobMs ?? INDEX_JOB_MS;
    this.metaJob = o.metaJob ?? META_JOB;
    this.idleMs = o.idleMs ?? IDLE_MS;
    this.capBytes = o.capBytes ?? null;
    this.batchPairs = Math.max(1, Math.min(WRITE_BATCH_PAIRS, o.batchPairs ?? WRITE_BATCH_PAIRS));
  }

  private get src() {
    return { src: this.deps.stamp.sourceKey };
  }

  /** False once the index is closed or its source's generation has moved on. */
  private current(): boolean {
    return !this.closed && this.deps.isCurrent();
  }

  /** Whether the index was found damaged. */
  get isDamaged(): boolean {
    return this.damaged;
  }

  /** Whether the index's teardown has begun. */
  get isClosed(): boolean {
    return this.closed;
  }

  setCondition(condition: IndexCondition): void {
    if (this.progress.condition === condition) return;
    this.progress.condition = condition;
    this.report(true);
  }

  /**
   * Tells the source that progress changed: now if `now` is set or the last
   * report is PROGRESS_MS old, else once that time is up.
   */
  private report(now = false): void {
    if (this.closed || !this.deps.onChange) return;
    const wait = this.lastReport + PROGRESS_MS - performance.now();
    if (!now && wait > 0) {
      this.reportTimer ??= setTimeout(() => {
        this.reportTimer = null;
        this.report(true);
      }, wait);
      return;
    }
    if (this.reportTimer) clearTimeout(this.reportTimer);
    this.reportTimer = null;
    this.lastReport = performance.now();
    this.deps.onChange();
  }

  /** Reports damage once; the source's lifecycle decides what happens next. */
  private damage(reason: string): void {
    if (this.damaged || this.closed) return;
    this.damaged = true;
    this.deps.onDamage?.(reason);
  }

  /** Reports damage found elsewhere, such as by the check. */
  reportDamage(reason: string): void {
    this.damage(reason);
  }

  /** Reports damage when a thread says SQLite found the file corrupt. */
  private watch(err: unknown): void {
    if (err instanceof ThreadError && err.code === 'INDEX_CORRUPT') this.damage('corrupt');
  }

  /**
   * Opens the source's index, creating it if there's none or the one there
   * isn't usable. With `create` false (the run is unavailable), only the
   * read-only query connection opens, and only to an index with the expected
   * identity: nothing is created, replaced or written. An index that was
   * already there is then checked in the background.
   */
  async open(
    expectedUuid: string | null,
    create = true,
    options: OpenOptions = {},
  ): Promise<IndexOpened> {
    if (!create) return this.openForBrowsing(expectedUuid);
    mkdirSync(this.deps.indexDir, { recursive: true, mode: 0o700 });
    chmodSync(this.deps.indexDir, 0o700);
    const writer = this.deps.thread('writer');
    this.writer = writer;
    writer.onRespawn = () => {
      this.connections.remove(this.writerEntry);
      this.writerEntry = null;
    };
    const opened = await writer.call<WriterOpened>('open', {
      dbPath: this.dbPath,
      stamp: this.deps.stamp,
      expectedUuid,
      capBytes: this.capBytes,
      exportRoots: this.deps.exportRoots ?? [],
      cancel: this.cancel,
    });
    this.writerEntry = this.connections.add({ role: 'writer', dbPath: this.dbPath });
    this.opened = opened;
    if (opened.replaced) {
      this.deps.log.warn('index.damaged', { reason: opened.mismatch ?? 'identity' }, this.src);
    }
    if (opened.created) this.deps.log.info('index.created', {}, this.src);
    this.progress.condition = opened.created
      ? options.rebuild || opened.replaced
        ? 'rebuilding'
        : 'ok'
      : 'verifying';
    this.startQuery();
    await this.openQuery();
    this.startIdleWatch();
    if (!opened.created) this.startCheck();
    return { dbUuid: opened.uuid, created: opened.created, replaced: opened.replaced };
  }

  /** The unavailable run's index, read-only, for browsing. */
  private async openForBrowsing(expectedUuid: string | null): Promise<IndexOpened> {
    if (expectedUuid === null) throw new ThreadError('NO_INDEX');
    this.opened = {
      uuid: expectedUuid,
      created: false,
      replaced: false,
      mismatch: null,
      phase1Done: false,
    };
    this.progress.phase = 'unavailable';
    this.progress.condition = 'verifying';
    this.startQuery();
    await this.openQuery();
    this.startIdleWatch();
    this.startCheck();
    return { dbUuid: expectedUuid, created: false, replaced: false };
  }

  private startQuery(): void {
    const query = this.deps.thread('query');
    this.query = query;
    query.onRespawn = () => {
      this.connections.remove(this.queryEntry);
      this.queryEntry = null;
      this.queryReady = null;
    };
  }

  private openQuery(): Promise<void> {
    const query = this.query;
    const uuid = this.opened?.uuid;
    if (!query || !uuid || this.closed) return Promise.reject(new ThreadError('NOT_OPEN'));
    this.queryReady ??= query.call('open', { dbPath: this.dbPath, expectedUuid: uuid }).then(
      () => {
        this.queryEntry = this.connections.add({ role: 'query', dbPath: this.dbPath });
      },
      (err: unknown) => {
        this.queryReady = null;
        throw err;
      },
    );
    return this.queryReady;
  }

  /**
   * Checks the index with SQLite's quick check, on its own connection in a
   * short-lived thread, with no time limit: it takes longer while phase 1
   * writes. The outcome goes to `onChecked` without waiting on anything, so a
   * teardown can always end and join the thread.
   */
  private startCheck(): void {
    const uuid = this.opened?.uuid;
    if (!uuid || this.closed || this.checking) return;
    const thread = this.deps.thread('verify');
    this.verifier = thread;
    const entry = this.connections.add({ role: 'verifier', dbPath: this.dbPath });
    const started = performance.now();
    this.checking = (async () => {
      let result: CheckResult | null = null;
      try {
        result = await thread.call<CheckResult>('check', {
          dbPath: this.dbPath,
          expectedUuid: uuid,
        });
      } catch {
        // Ended by a teardown, or the thread failed.
      }
      // The thread is short-lived: its connection closes with it.
      await thread.stop();
      this.connections.remove(entry);
      this.verifier = null;
      this.deps.onChecked?.(result, Math.round(performance.now() - started));
    })();
  }

  /** Resolves once the check of an existing index, if one started, has ended. */
  async checkEnded(): Promise<void> {
    await this.checking;
  }

  /** Answers a query from the read-only connection. */
  async ask(call: IndexQuery): Promise<IndexAnswer> {
    this.touch();
    try {
      await this.openQuery();
      const answer = await this.query!.call<IndexAnswer>('query', { call });
      if (call.op === 'search' || call.op === 'snippets') {
        // A snippet whose match ranges failed the check is given as plain text.
        const dropped = (answer as SearchPage | SearchSnippets | null)?.dropped ?? 0;
        if (dropped > 0) this.deps.log.warn('search.ranges_dropped', { count: dropped }, this.src);
      }
      return answer;
    } catch (err) {
      this.watch(err);
      throw err;
    }
  }

  /** Starts phase 1 for the pairs the index doesn't have yet. */
  startPhase1(scan: RunScan): Promise<void> {
    this.running ??= this.runPhase1(scan).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Resolves when phase 1, if running, has ended. */
  async settled(): Promise<void> {
    await this.running;
  }

  private touch(): void {
    this.lastActive = Date.now();
    this.released = false;
  }

  private startIdleWatch(): void {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(
      () => void this.releaseIfIdle(),
      Math.max(250, Math.min(this.idleMs, 5000)),
    );
    this.idleTimer.unref?.();
  }

  /** Releases SQLite's caches once nothing has run for IDLE_MS. Resolves true if it did. */
  async releaseIfIdle(now = Date.now()): Promise<boolean> {
    if (this.released || this.running || this.closed) return false;
    if (now - this.lastActive < this.idleMs) return false;
    this.released = true;
    await Promise.all([
      this.writer?.call('shrink').catch(() => undefined),
      this.query?.call('shrink').catch(() => undefined),
    ]);
    this.deps.log.info('index.idle_release', {}, this.src);
    return true;
  }

  private startPool(): Pool {
    this.pool ??= new Pool(Array.from({ length: this.poolSize }, () => this.deps.thread('parse')));
    return this.pool;
  }

  private async stopPool(): Promise<void> {
    const pool = this.pool;
    this.pool = null;
    await pool?.stop();
  }

  private async runPhase1(scan: RunScan): Promise<void> {
    const started = performance.now();
    const stamp = this.deps.stamp;
    this.touch();
    this.progress.total = scan.metadata.size;
    try {
      const writer = this.writer;
      if (!writer || !this.opened) throw new ThreadError('NOT_OPEN');
      const pool = this.startPool();
      if (!this.current()) {
        this.deps.log.info(
          'writer.stale_dropped',
          { generation: stamp.generation, count: scan.metadata.size },
          this.src,
        );
        throw new ThreadError('STALE');
      }
      const plan = await writer.call<ReconcilePlan>('plan', {
        metadata: scan.metadata,
        eml: scan.eml,
      });
      await this.reconcileLabels(pool, writer, scan.labels, plan.labelsStat);
      const toRead: ApplyItem[] = [];
      const now: ApplyItem[] = [];
      for (const change of plan.changes) {
        const meta = scan.metadata.get(change.protonId);
        const eml = scan.eml.get(change.protonId);
        const files: PairFiles = {
          protonId: change.protonId,
          meta: meta ? fileStat(meta) : null,
          eml: eml ? fileStat(eml) : null,
        };
        (change.meta === 'parse' ? toRead : now).push({ change, files });
      }
      // Loading starts at what the index already has, so a reopen never shows 0.
      this.progress.loaded = scan.metadata.size - toRead.length;
      this.progress.phase = 'loading';
      this.report(true);
      // Changes that need nothing read: at most 1,000 pairs per transaction.
      const reconciled = performance.now();
      for (const part of chunk(now, WRITE_BATCH_PAIRS)) {
        if (!this.current()) throw new ThreadError('STALE');
        const result = await writer.call<ApplyResult>('apply', { stamp, items: part });
        if (result.stale) throw new ThreadError('STALE');
        this.touch();
      }
      // Pairs the index had that changed; new pairs are counted as they are read.
      const known = plan.changes.filter((c) => !c.fresh).length;
      if (known > 0) {
        this.deps.log.info(
          'index.reconciled',
          { count: known, ms: Math.round(performance.now() - reconciled) },
          this.src,
        );
      }
      if (__PEV_TEST_HOOKS__ && this.deps.options?.readByName) {
        toRead.sort((a, b) => (a.files.protonId < b.files.protonId ? -1 : 1));
      }
      await this.readAndWrite(pool, writer, toRead, scan.metadata);
      if (!this.current()) throw new ThreadError('STALE');
      await writer.call('finish', { stamp });
      this.progress.phase = 'done';
      if (this.progress.condition === 'rebuilding') this.progress.condition = 'ok';
      this.report(true);
      this.deps.log.info(
        'index.phase1_done',
        { count: this.progress.loaded, ms: Math.round(performance.now() - started) },
        this.src,
      );
    } catch (err) {
      this.progress.phase = 'failed';
      this.report(true);
      this.watch(err);
      const code = err instanceof ThreadError ? err.code : 'FAILED';
      this.deps.log.warn('index.phase1_failed', { reason: failureReason(code) }, this.src);
    } finally {
      await this.stopPool();
      this.touch();
    }
  }

  /**
   * Reads the metadata of new and changed pairs and writes it, in batches of
   * at most 1,000 pairs and 4 MiB. Each batch first gets its revs (a new pair
   * is registered, a changed one moves to the next rev), so every result
   * carries the rev it was read for. A few batches are read ahead of the
   * writer, and none is read before the one before it was dispatched.
   */
  private async readAndWrite(
    pool: Pool,
    writer: IndexThread,
    toRead: ApplyItem[],
    refs: Map<string, FileRef>,
  ): Promise<void> {
    const stamp = this.deps.stamp;
    const batches = splitBatches(
      toRead,
      this.batchPairs,
      TXN_INPUT_BYTES,
      (u) => u.files.meta?.size ?? 0,
    );
    let writes: Promise<void> = Promise.resolve();
    let failure: unknown = null;
    const inFlight = new Set<Promise<void>>();
    const stale = (count: number): void => {
      this.deps.log.info('writer.stale_dropped', { generation: stamp.generation, count }, this.src);
    };
    // A batch's writes are queued once it has been read, so batches read
    // together can be written in either order. Builds with test hooks can
    // keep the order the batches were made in.
    const inOrder = __PEV_TEST_HOOKS__ && this.deps.options?.readByName === true;
    let queued: Promise<void> = Promise.resolve();
    for (const batch of batches) {
      if (failure) break;
      if (!this.current()) {
        stale(batch.length);
        failure = new ThreadError('STALE');
        break;
      }
      // Settles once the batch before this one has queued its writes or failed.
      const turn = queued;
      let done = (): void => undefined;
      if (inOrder) queued = new Promise<void>((resolve) => (done = resolve));
      const job = writer
        .call<ApplyResult>('apply', { stamp, items: batch })
        .then((applied) => {
          if (applied.stale) throw new ThreadError('STALE');
          const revs = new Map(applied.revs);
          // A pair the plan saw differently is left alone, as if handled.
          this.progress.loaded += batch.length - revs.size;
          return this.parseBatch(
            pool,
            batch.map((u) => u.files).filter((p) => revs.has(p.protonId)),
            refs,
            revs,
          );
        })
        .then((sized) => (inOrder ? turn.then(() => sized) : sized))
        .then((sized) => {
          // The budget again, on the bytes actually read: a file can have
          // grown since the scan.
          const parts = splitBatches(sized, this.batchPairs, TXN_INPUT_BYTES, (s) => s.bytes);
          writes = writes.then(async () => {
            for (const part of parts) {
              if (__PEV_TEST_HOOKS__ && this.deps.options?.beforeWrite) {
                await Promise.race([this.deps.options.beforeWrite(), this.closing]);
              }
              if (failure) return;
              const items = part.map((s) => s.item);
              if (!this.current()) {
                stale(items.length);
                failure = new ThreadError('STALE');
                return;
              }
              try {
                const result = await writer.call<BatchResult>('phase1', { stamp, items });
                this.afterBatch(result, items);
              } catch (err) {
                failure = err;
              }
            }
          });
          done();
          return writes;
        })
        .catch((err: unknown) => {
          failure ??= err;
          done();
        });
      const tracked = job.finally(() => inFlight.delete(tracked));
      inFlight.add(tracked);
      if (inFlight.size > BATCHES_AHEAD) await Promise.race(inFlight);
    }
    await Promise.all(inFlight);
    await writes;
    if (failure) throw failure;
  }

  /**
   * Stores labels.json again only if it isn't the file the stored labels came
   * from. With no labels.json any more, the stored labels go.
   */
  private async reconcileLabels(
    pool: Pool,
    writer: IndexThread,
    ref: FileRef | null,
    storedStat: string | null,
  ): Promise<void> {
    const stat = ref ? labelsStatOf(fileStat(ref)) : null;
    if (stat === storedStat) return;
    if (!ref) {
      await writer.call('labels', { stamp: this.deps.stamp, labels: [], stat: null });
      return;
    }
    let result: LabelsJobResult;
    try {
      result = await pool.run<LabelsJobResult>('labels', { root: this.deps.root, ref }, this.jobMs);
    } catch (err) {
      const code = err instanceof ThreadError && err.code === TIMEOUT ? 'META_TIMEOUT' : 'FAILED';
      this.deps.log.warn('index.labels_failed', { reason: reasonOf(code) }, this.src);
      return;
    }
    if (!result.labels) {
      this.deps.log.warn('index.labels_failed', { reason: reasonOf(result.error ?? '') }, this.src);
      return;
    }
    await writer.call('labels', {
      stamp: this.deps.stamp,
      labels: result.labels,
      stat: labelsStatOf(fileStat(result.ref)),
    });
  }

  /**
   * Reads and parses a batch's metadata files on the pool. Each item carries
   * the rev its pair was given for this read, and the bytes actually read,
   * which can differ from the scan's size.
   */
  private async parseBatch(
    pool: Pool,
    batch: PairFiles[],
    refs: Map<string, FileRef>,
    revs: Map<string, number>,
  ): Promise<Array<{ item: Phase1Item; bytes: number }>> {
    const jobs = chunk(batch, this.metaJob).map((job) =>
      this.parseJob(
        pool,
        job.map((p) => ({ protonId: p.protonId, ref: refs.get(p.protonId)! })),
      ),
    );
    const results = new Map<string, MetaJobResult>();
    for (const list of await Promise.all(jobs)) for (const r of list) results.set(r.protonId, r);
    return batch.map((pair) => {
      const r = results.get(pair.protonId);
      return {
        item: {
          pair: r ? { ...pair, meta: fileStat(r.ref) } : pair,
          expectedRev: revs.get(pair.protonId)!,
          row: r?.row ?? null,
          error: r ? r.error : 'META_FAILED',
        },
        bytes: r?.bytes ?? 0,
      };
    });
  }

  /**
   * Runs one job. If it runs past its limit (or its thread dies), each of its
   * files is tried again on its own, so only the file that breaches gets the
   * timeout code.
   */
  private async parseJob(pool: Pool, items: MetaJobItem[]): Promise<MetaJobResult[]> {
    try {
      return await pool.run<MetaJobResult[]>('meta', { root: this.deps.root, items }, this.jobMs);
    } catch (err) {
      const code = err instanceof ThreadError ? err.code : 'FAILED';
      if (items.length === 1) {
        if (code === TIMEOUT) this.progress.timeouts += 1;
        return [
          {
            protonId: items[0]!.protonId,
            row: null,
            error: code === TIMEOUT ? 'META_TIMEOUT' : 'META_FAILED',
            ref: items[0]!.ref,
            bytes: 0,
          },
        ];
      }
      if (code === TIMEOUT) this.progress.timeouts += 1;
      const singles = await Promise.all(items.map((item) => this.parseJob(pool, [item])));
      return singles.flat();
    }
  }

  private afterBatch(result: BatchResult, items: Phase1Item[]): void {
    this.touch();
    const handled = items.filter((i) => i.pair.meta !== null).length;
    this.progress.loaded += handled;
    this.progress.failed += result.failed;
    this.progress.capped += result.capped.length;
    this.report();
    for (const { fileId, capped } of result.capped) {
      for (const list of CAPPED_LISTS) {
        if (capped & CAPPED[list]) {
          this.deps.log.info('index.capped', { fileId, list }, this.src);
        }
      }
    }
    for (const { fileId, code } of result.errors) {
      this.deps.log.info(
        code === 'META_TIMEOUT' ? 'index.timeout' : 'index.meta_failed',
        { fileId, reason: reasonOf(code) },
        this.src,
      );
    }
  }

  /**
   * The index's part of a teardown: no new work starts, queued jobs are
   * cancelled, the write in flight stops and rolls back, the check is ended
   * and joined, and every connection is closed. Resolves once all of that has
   * happened.
   */
  async close(): Promise<void> {
    this.closed = true;
    this.endClosing();
    if (this.reportTimer) clearTimeout(this.reportTimer);
    this.reportTimer = null;
    Atomics.store(new Int32Array(this.cancel), 0, 1);
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
    await this.stopPool();
    await this.running;
    await this.verifier?.stop();
    await this.checking;
    for (const role of ['query', 'writer'] as const) {
      const thread = role === 'query' ? this.query : this.writer;
      if (!thread) continue;
      await thread.call('close').catch(() => undefined);
      await thread.stop();
      if (role === 'query') this.connections.remove(this.queryEntry);
      else this.connections.remove(this.writerEntry);
    }
    this.queryEntry = null;
    this.writerEntry = null;
    this.query = null;
    this.writer = null;
  }
}

function failureReason(code: string): string {
  switch (code) {
    case 'STALE':
    case 'CANCELLED':
    case THREAD_STOPPED:
      return 'stale_generation';
    case 'INDEX_CORRUPT':
      return 'corrupt';
    case 'INDEX_FULL':
      return 'index_full';
    case 'WAL_STOP':
    case 'WAL_BUSY':
    case 'WAL_HEADROOM':
      return 'wal';
    default:
      return 'worker_failed';
  }
}
