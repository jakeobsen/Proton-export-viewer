// SPDX-License-Identifier: AGPL-3.0-or-later
// The bench in core: it runs the index phases with core's thread layout (one
// writer, one query thread, an index pool and a reader lane), with a
// wall-clock limit on every job, and answers main's timed requests.

import { lstatSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { FileError, readContained, scanRun, type FileRef } from './files';
import { BODY_STATE } from './schema';
import type { DbTarget, Role } from './worker';
import type {
  BodyResult,
  LabelEntry,
  PairInfo,
  Phase1Item,
  Phase1Stats,
  Phase2Stats,
} from './writer';

export interface InitArgs {
  runDir: string;
  target: DbTarget;
  poolSize: number;
  oldGenMb: number;
  indexCapBytes: number;
  phase1Batch: number;
  phase2Batch: number;
  metaJob: number;
  indexJobMs: number;
  readerJobMs: number;
  /** Index only the first N pairs, in file-name order (for size analysis). */
  maxMessages?: number;
}

/** Parsed batches allowed ahead of the writer, so parsed text never piles up. */
const BATCHES_AHEAD = 2;
/** The most body text one phase 2 write transaction carries, so its WAL growth stays bounded. */
const PHASE2_TXN_TEXT_BYTES = 4 * 1024 * 1024;
const WATCHDOG_MS = 20;

/** The index family's size on disk: the database, its WAL and its shared-memory file. */
export function familyBytes(dbPath: string): number {
  let total = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      total += statSync(dbPath + suffix).size;
    } catch {
      // A file of the family that doesn't exist counts as empty.
    }
  }
  return total;
}

interface Reply {
  id: number;
  ok: boolean;
  data?: unknown;
  error?: string;
  heap: number;
  heapPeak: number;
}

export class JobTimeout extends Error {
  constructor() {
    super('TIMEOUT');
  }
}

/** One worker thread with request/response calls; a breach terminates and respawns it. */
class Thread {
  private worker: Worker;
  private seq = 0;
  private readonly pending = new Map<
    number,
    { resolve: (r: Reply) => void; reject: (e: Error) => void }
  >();
  heapPeak = 0;
  respawns = 0;

  constructor(
    private readonly file: string,
    private readonly role: Role,
    private readonly oldGenMb: number,
  ) {
    this.worker = this.spawn();
  }

  private spawn(): Worker {
    const w = new Worker(this.file, {
      workerData: { role: this.role },
      resourceLimits: { maxOldGenerationSizeMb: this.oldGenMb },
    });
    const fail = (err: Error) => {
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
    w.on('message', (r: Reply) => {
      this.heapPeak = Math.max(this.heapPeak, r.heapPeak);
      const p = this.pending.get(r.id);
      if (!p) return;
      this.pending.delete(r.id);
      p.resolve(r);
    });
    w.on('error', (err: NodeJS.ErrnoException) => fail(new Error(err.code ?? 'WORKER_ERROR')));
    w.on('exit', () => {
      if (this.worker === w) {
        fail(new Error('WORKER_EXIT'));
        this.worker = this.spawn();
        this.respawns += 1;
      }
    });
    return w;
  }

  async call<T>(op: string, args: Record<string, unknown> = {}, timeoutMs = 0): Promise<T> {
    this.seq += 1;
    const id = this.seq;
    const reply = await new Promise<Reply>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...args, id, op });
      if (timeoutMs > 0) {
        setTimeout(() => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          reject(new JobTimeout());
          const old = this.worker;
          this.worker = this.spawn();
          this.respawns += 1;
          void old.terminate();
        }, timeoutMs);
      }
    });
    if (!reply.ok) throw new Error(reply.error ?? 'FAILED');
    return reply.data as T;
  }

  get threadId(): number {
    return this.worker.threadId;
  }

  async stop(): Promise<void> {
    const w = this.worker;
    this.worker = null as unknown as Worker;
    await w.terminate();
    for (const p of this.pending.values()) p.reject(new Error('WORKER_STOPPED'));
    this.pending.clear();
  }
}

/** Runs index jobs on the pool, first come first served. */
class Pool {
  private readonly idle: Thread[];
  private readonly queue: Array<() => void> = [];

  constructor(readonly threads: Thread[]) {
    this.idle = [...threads];
  }

  async run<T>(op: string, args: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const thread =
      this.idle.pop() ??
      (await new Promise<Thread>((r) => this.queue.push(() => r(this.idle.pop()!))));
    try {
      return await thread.call<T>(op, args, timeoutMs);
    } finally {
      this.idle.push(thread);
      this.queue.shift()?.();
    }
  }
}

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

const ms = (since: number) => performance.now() - since;

interface BatchRecord extends Phase1Stats {
  index: number;
  readyMs: number;
  committedMs: number;
  indexBytes: number;
}

interface Phase2Record {
  messages: number;
  ms: number;
  states: Record<string, number>;
  inputBytes: number;
  jobMs: number[];
  writerMs: number[];
  writerBatches: number;
  dropped: number;
  timeouts: number;
  maxIndexBytes: number;
  invalid: string | null;
  peakFamilyBytes?: number;
}

class Bench {
  private readonly writer: Thread;
  private readonly query: Thread;
  private readonly reader: Thread;
  private readonly pool: Pool;
  private pairs: PairInfo[] = [];
  private parsed = new Set<string>();
  private queryOpen = false;
  private invalid: string | null = null;
  private phase2: Promise<Phase2Record> | null = null;
  phase2Done = 0;

  constructor(
    private readonly dir: string,
    readonly args: InitArgs,
  ) {
    const file = join(dir, 'bench-worker.js');
    this.writer = new Thread(file, 'writer', args.oldGenMb);
    this.query = new Thread(file, 'query', args.oldGenMb);
    this.reader = new Thread(file, 'reader', args.oldGenMb);
    this.pool = new Pool(
      Array.from({ length: args.poolSize }, () => new Thread(file, 'index', args.oldGenMb)),
    );
  }

  async init(): Promise<unknown> {
    return this.writer.call('init', { target: this.args.target });
  }

  peakFamilyBytes = 0;

  private checkCap(indexBytes: number): void {
    this.peakFamilyBytes = Math.max(this.peakFamilyBytes, indexBytes);
    if (indexBytes > this.args.indexCapBytes) this.invalid = 'INDEX_CAP';
  }

  /**
   * Watches the index family while the writer works. Past the cap the run is
   * invalid and the writer thread is stopped at once, mid-transaction if need be.
   */
  private watch(): () => void {
    const timer = setInterval(() => {
      const size = familyBytes(this.args.target.dbPath);
      this.peakFamilyBytes = Math.max(this.peakFamilyBytes, size);
      if (size > this.args.indexCapBytes && !this.invalid) {
        this.invalid = 'INDEX_CAP';
        void this.writer.stop();
      }
    }, WATCHDOG_MS);
    return () => clearInterval(timer);
  }

  private fail(err: unknown): void {
    this.invalid ??= (err as Error)?.message || 'WRITER_FAILED';
  }

  private async openQuery(): Promise<void> {
    if (this.queryOpen) return;
    await this.query.call('open', { target: this.args.target });
    this.queryOpen = true;
  }

  async phase1(): Promise<unknown> {
    const unwatch = this.watch();
    try {
      return await this.runPhase1();
    } finally {
      unwatch();
    }
  }

  private async runPhase1(): Promise<unknown> {
    const t0 = performance.now();
    const scan = scanRun(this.args.runDir);
    const scanMs = ms(t0);
    if (scan.labelsPath) {
      const doc = JSON.parse(
        readContained(this.refOf(scan.labelsPath), 4 * 1024 * 1024).toString('utf8'),
      ) as { Payload?: Array<Record<string, unknown>> };
      const labels: LabelEntry[] = (doc.Payload ?? []).map((l) => ({
        id: String(l.ID ?? ''),
        name: String(l.Name ?? ''),
        path: String(l.Path ?? ''),
        parentId: String(l.ParentID ?? ''),
        color: typeof l.Color === 'string' ? l.Color : null,
        type: Number(l.Type ?? 0),
      }));
      await this.writer.call('labels', { labels });
    }
    if (this.args.maxMessages) scan.pairs = scan.pairs.slice(0, this.args.maxMessages);
    this.pairs = scan.pairs;
    const byId = new Map(scan.pairs.map((p) => [p.protonId, p]));
    const batches: BatchRecord[] = [];
    let firstRowsMs: number | null = null;
    let firstRows: Promise<void> | null = null;
    let writes: Promise<unknown> = Promise.resolve();

    const runBatch = async (index: number, pairs: PairInfo[]) => {
      const jobs = chunk(pairs, this.args.metaJob).map((job) =>
        this.pool
          .run<Array<{ protonId: string; row: Phase1Item['row']; error: string | null }>>(
            'meta',
            {
              items: job.map((p) => ({
                protonId: p.protonId,
                ref: { path: join(this.args.runDir, p.metaRel), dev: p.metaDev, ino: p.metaIno },
              })),
            },
            this.args.indexJobMs,
          )
          .catch((err: Error) =>
            job.map((p) => ({ protonId: p.protonId, row: null, error: err.message })),
          ),
      );
      const parsed = (await Promise.all(jobs)).flat();
      const readyMs = ms(t0);
      const items: Phase1Item[] = parsed.map((r) => ({
        pair: byId.get(r.protonId)!,
        row: r.row,
        error: r.error,
      }));
      writes = writes.then(async () => {
        if (this.invalid) return;
        const stats = await this.writer
          .call<Phase1Stats & { indexBytes: number }>('phase1', {
            items,
            dbPath: this.args.target.dbPath,
          })
          .catch((err: unknown) => this.fail(err));
        if (!stats) return;
        for (const r of parsed) if (r.row) this.parsed.add(r.protonId);
        batches.push({ ...stats, index, readyMs, committedMs: ms(t0) });
        this.checkCap(stats.indexBytes);
        firstRows ??= (async () => {
          await this.openQuery();
          const page = await this.query.call<{ rows: number }>('list', {
            labelId: '5',
            after: null,
          });
          if (page.rows > 0) firstRowsMs = ms(t0);
        })();
      });
      await writes;
    };

    const inFlight = new Set<Promise<void>>();
    for (const [i, pairs] of chunk(scan.pairs, this.args.phase1Batch).entries()) {
      if (this.invalid) break;
      const batch = runBatch(i, pairs).finally(() => inFlight.delete(batch));
      inFlight.add(batch);
      if (inFlight.size > BATCHES_AHEAD) await Promise.race(inFlight);
    }
    await Promise.all(inFlight);
    await firstRows;
    const phase1Ms = ms(t0);
    const totals = this.invalid
      ? null
      : await this.writer.call('totals', { dbPath: this.args.target.dbPath });
    return {
      invalid: this.invalid,
      peakFamilyBytes: this.peakFamilyBytes,
      scanMs,
      pairs: scan.pairs.length,
      rejected: scan.rejected,
      firstRowsMs,
      phase1Ms,
      batches,
      totals,
    };
  }

  private refOf(path: string): FileRef {
    const pair = this.pairs.find((p) => join(this.args.runDir, p.metaRel) === path);
    if (pair) return { path, dev: pair.metaDev, ino: pair.metaIno };
    // labels.json: checked against its own lstat, as the scan does for pairs.
    const st = lstatSync(path);
    return { path, dev: st.dev, ino: st.ino };
  }

  startPhase2(): void {
    if (this.phase2) return;
    const unwatch = this.watch();
    this.phase2 = this.runPhase2().finally(unwatch);
  }

  waitPhase2(): Promise<Phase2Record> {
    if (!this.phase2) throw new Error('phase 2 not started');
    return this.phase2;
  }

  private async runPhase2(): Promise<Phase2Record> {
    const t0 = performance.now();
    const todo = this.pairs.filter((p) => p.emlRel !== null && this.parsed.has(p.protonId));
    const revs = await this.writer.call<Array<number | null>>('revs', {
      ids: todo.map((p) => p.protonId),
    });
    const record: Phase2Record = {
      messages: todo.length,
      ms: 0,
      states: {},
      inputBytes: 0,
      jobMs: [],
      writerMs: [],
      writerBatches: 0,
      dropped: 0,
      timeouts: 0,
      maxIndexBytes: 0,
      invalid: null,
    };
    let buffer: BodyResult[] = [];
    let bufferBytes = 0;
    let writes: Promise<unknown> = Promise.resolve();
    const pending: Array<Promise<unknown>> = [];
    const flush = () => {
      if (buffer.length === 0) return;
      const results = buffer;
      buffer = [];
      bufferBytes = 0;
      writes = writes.then(async () => {
        if (this.invalid) return;
        const stats = await this.writer
          .call<Phase2Stats & { indexBytes: number }>('phase2', {
            results,
            dbPath: this.args.target.dbPath,
          })
          .catch((err: unknown) => this.fail(err));
        if (!stats) return;
        record.writerMs.push(stats.ms);
        record.writerBatches += 1;
        record.dropped += stats.dropped;
        record.maxIndexBytes = Math.max(record.maxIndexBytes, stats.indexBytes);
        this.checkCap(stats.indexBytes);
      });
      const written = writes.finally(() => pending.splice(pending.indexOf(written), 1));
      pending.push(written);
    };
    let next = 0;
    const lane = async () => {
      while (next < todo.length && !this.invalid) {
        // Backpressure: wait while the writer has two batches queued.
        while (pending.length >= BATCHES_AHEAD) await pending[0];
        if (next >= todo.length || this.invalid) break;
        const i = next++;
        const p = todo[i]!;
        const rev = revs[i]!;
        let result: BodyResult;
        try {
          const r = await this.pool.run<{
            state: number;
            text: string;
            ms: number;
            inputBytes: number;
          }>(
            'body',
            { ref: { path: join(this.args.runDir, p.emlRel!), dev: p.emlDev, ino: p.emlIno } },
            this.args.indexJobMs,
          );
          record.jobMs.push(r.ms);
          record.inputBytes += r.inputBytes;
          result = { protonId: p.protonId, rev, state: r.state, text: r.text, error: null };
        } catch (err) {
          if (err instanceof JobTimeout) record.timeouts += 1;
          const code = err instanceof FileError ? err.code : (err as Error).message;
          result = {
            protonId: p.protonId,
            rev,
            state: BODY_STATE.failed,
            text: '',
            error: code.slice(0, 64),
          };
        }
        record.states[result.state] = (record.states[result.state] ?? 0) + 1;
        buffer.push(result);
        bufferBytes += Buffer.byteLength(result.text);
        this.phase2Done += 1;
        if (buffer.length >= this.args.phase2Batch || bufferBytes >= PHASE2_TXN_TEXT_BYTES) flush();
      }
    };
    await Promise.all(Array.from({ length: this.pool.threads.length * 2 }, lane));
    flush();
    await writes;
    record.ms = ms(t0);
    record.invalid = this.invalid;
    record.peakFamilyBytes = this.peakFamilyBytes;
    return record;
  }

  async search(args: Record<string, unknown>): Promise<unknown> {
    await this.openQuery();
    return this.query.call(args.list ? 'list' : 'search', args);
  }

  async open(protonId: string): Promise<unknown> {
    const p = this.pairs.find((x) => x.protonId === protonId);
    if (!p || p.emlRel === null) throw new Error('NO_SUCH_MESSAGE');
    return this.reader.call(
      'open',
      { ref: { path: join(this.args.runDir, p.emlRel), dev: p.emlDev, ino: p.emlIno } },
      this.args.readerJobMs,
    );
  }

  /** Messages that open through the reader lane: an .eml of at most `maxBytes`. */
  sample(count: number, maxBytes: number): string[] {
    const fit = this.pairs.filter(
      (p) => p.emlSize !== null && p.emlSize <= maxBytes && this.parsed.has(p.protonId),
    );
    const step = Math.max(1, Math.floor(fit.length / count));
    return fit
      .filter((_, i) => i % step === 0)
      .slice(0, count)
      .map((p) => p.protonId);
  }

  totals(): Promise<unknown> {
    return this.writer.call('totals', { dbPath: this.args.target.dbPath });
  }

  mergeAll(): Promise<unknown> {
    return this.writer.call('merge-all', { dbPath: this.args.target.dbPath });
  }

  checkpoint(): Promise<unknown> {
    return this.writer.call('checkpoint', { dbPath: this.args.target.dbPath });
  }

  heapPeaks(): Record<string, number> {
    return {
      writer: this.writer.heapPeak,
      query: this.query.heapPeak,
      reader: this.reader.heapPeak,
      index: Math.max(0, ...this.pool.threads.map((t) => t.heapPeak)),
    };
  }

  /** Asks both connections to give back their page caches. */
  async shrink(): Promise<void> {
    await this.writer.call('shrink');
    await this.query.call('shrink');
  }

  /** Ends the index pool, as the app does once indexing is done. */
  async stopPool(): Promise<void> {
    await Promise.all(this.pool.threads.map((t) => t.stop()));
    this.pool.threads.length = 0;
  }

  respawns(): number {
    return [this.writer, this.query, this.reader, ...this.pool.threads].reduce(
      (n, t) => n + t.respawns,
      0,
    );
  }

  async close(deleteIndex: boolean): Promise<void> {
    await this.writer.call('close').catch(() => undefined);
    await this.query.call('close').catch(() => undefined);
    await Promise.all(
      [this.writer, this.query, this.reader, ...this.pool.threads].map((t) => t.stop()),
    );
    if (deleteIndex) removeIndex(this.args.target.dbPath);
  }
}

export function removeIndex(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(dbPath + suffix, { force: true });
}

/** Extraction of one streamed large part in a fresh worker, with core's RSS sampled. */
async function large(
  dir: string,
  args: Record<string, unknown>,
  oldGenMb: number,
): Promise<unknown> {
  const thread = new Thread(join(dir, 'bench-worker.js'), 'index', oldGenMb);
  try {
    await thread.call('meta', { items: [] });
    await new Promise((r) => setTimeout(r, 500));
    const baseline = process.memoryUsage.rss();
    let peak = baseline;
    const timer = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage.rss());
    }, 10);
    try {
      const result = await thread.call<Record<string, unknown>>('large', args, 600_000);
      peak = Math.max(peak, process.memoryUsage.rss());
      return {
        ...result,
        rssBaseline: baseline,
        rssPeak: peak,
        rssGrowth: peak - baseline,
        heapPeak: thread.heapPeak,
      };
    } finally {
      clearInterval(timer);
    }
  } finally {
    await thread.stop();
  }
}

/** Warm reopen: a fresh read-only connection, the identity check, then the first list page. */
async function reopen(dir: string, args: Record<string, unknown>): Promise<unknown> {
  const t0 = performance.now();
  const thread = new Thread(join(dir, 'bench-worker.js'), 'query', 512);
  try {
    const opened = await thread.call<{ ms: number; identity: boolean | null }>('open', {
      target: args.target,
      uuid: args.uuid,
    });
    const page = await thread.call<{ ms: number; rows: number }>('list', {
      labelId: '5',
      after: null,
    });
    await thread.call('close');
    return {
      ms: ms(t0),
      openMs: opened.ms,
      identity: opened.identity,
      listMs: page.ms,
      rows: page.rows,
    };
  } finally {
    await thread.stop();
  }
}

let bench: Bench | null = null;

export async function handleBench(payload: unknown, dir: string): Promise<unknown> {
  const p = payload as { op: string } & Record<string, unknown>;
  switch (p.op) {
    case 'init': {
      if (bench) await bench.close(false);
      bench = new Bench(dir, p.args as InitArgs);
      return bench.init();
    }
    case 'phase1':
      return bench!.phase1();
    case 'phase2-start':
      bench!.startPhase2();
      return null;
    case 'phase2-wait':
      return bench!.waitPhase2();
    case 'phase2-progress':
      return bench!.phase2Done;
    case 'search':
      return bench!.search(p);
    case 'open':
      return bench!.open(p.protonId as string);
    case 'sample':
      return bench!.sample(p.count as number, p.maxBytes as number);
    case 'totals':
      return bench!.totals();
    case 'merge-all':
      return bench!.mergeAll();
    case 'checkpoint':
      return bench!.checkpoint();
    case 'threads':
      return {
        heapPeaks: bench!.heapPeaks(),
        respawns: bench!.respawns(),
        rss: process.memoryUsage.rss(),
      };
    case 'memory':
      return process.memoryUsage();
    case 'shrink':
      await bench!.shrink();
      return null;
    case 'pool-stop':
      await bench!.stopPool();
      return null;
    case 'close': {
      await bench?.close(Boolean(p.deleteIndex));
      bench = null;
      return null;
    }
    case 'large':
      return large(dir, p, (p.oldGenMb as number) ?? 512);
    case 'reopen':
      return reopen(dir, p);
    case 'remove-index':
      removeIndex(p.dbPath as string);
      return null;
  }
  throw new Error(`unknown bench op ${p.op}`);
}
