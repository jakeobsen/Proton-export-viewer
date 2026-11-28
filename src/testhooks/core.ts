// SPDX-License-Identifier: AGPL-3.0-or-later
// Core-process test hooks: hold opens to keep them pending, push markers
// through every logging path, set the reader's source and limits, open the
// source's gates, report the reader's memory, and turn the unsanitized path
// on or off.

import type { ReaderLane } from '../core/reader/lane';
import type { ReaderSource } from '../core/reader/source';
import type {
  CoreResult,
  IndexQueryRequest,
  OpenRequest,
  TestRequest,
  WorkerMessage,
  WorkerRequest,
} from '../shared/core-protocol';
import { errorData } from '../shared/log/schema';
import type { LogWriter } from '../shared/log/writer';
import type { SourceSession } from '../core/source';
import type { ReadRequest } from '../shared/reader-protocol';
import { markLoaded } from './marker';
import { READER_UNSANITIZED_ACTION } from './unsanitized';
import {
  READER_SOURCE_ACTION,
  TestReaderSource,
  openGate,
  parsePayload,
  waitingAt,
} from './reader-source';

markLoaded();

export interface CoreTestDeps {
  log: LogWriter;
  roots: Array<[string, string]>;
  state: {
    holding: boolean;
    held: Array<OpenRequest | ReadRequest>;
    fileOpens: number;
    unsanitized: boolean;
    searches: number;
    holdingSearches: boolean;
    heldSearches: IndexQueryRequest[];
    holdingOpened: boolean;
    heldOpened: Array<() => void>;
    holdCardsAt: number | null;
    heldCards: Array<() => void>;
  };
  open: (request: OpenRequest | ReadRequest) => void;
  toWorker: (message: WorkerRequest) => void;
  reply: (result: CoreResult) => void;
  /** The folder of core's own script, where its worker scripts are. */
  dir: string;
  /** The open source, if core was started with one. */
  session: SourceSession | null;
  lane: ReaderLane<WorkerRequest, WorkerMessage>;
  setReaderSource: (source: ReaderSource) => void;
  readerSource: () => ReaderSource | null;
  writeGate: WriteGate | null;
  /** Runs a search that was held. */
  runSearch: (request: IndexQueryRequest) => void;
}

/** Holds phase 1's writes, while holding, until a test lets them through. */
export class WriteGate {
  private allowed = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private holding: boolean) {}

  readonly beforeWrite = (): Promise<void> => {
    if (!this.holding) return Promise.resolve();
    if (this.allowed > 0) {
      this.allowed -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  };

  /** Lets `count` more writes through; null stops holding. */
  release(count: number | null): void {
    if (count === null) this.holding = false;
    else this.allowed += count;
    while (this.waiting.length > 0 && (!this.holding || this.allowed > 0)) {
      if (this.holding) this.allowed -= 1;
      this.waiting.shift()?.();
    }
  }

  /** Writes waiting to be let through. */
  get held(): number {
    return this.waiting.length;
  }
}

function limits(payload: unknown): { heapMb?: number; timeoutMs?: number } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { heapMb, timeoutMs } = payload as { heapMb?: unknown; timeoutMs?: unknown };
  const ok = (v: unknown, min: number, max: number) =>
    v === undefined || (Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max);
  if (!ok(heapMb, 16, 4096) || !ok(timeoutMs, 100, 60_000)) return null;
  return {
    ...(heapMb === undefined ? {} : { heapMb: heapMb as number }),
    ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }),
  };
}

/** Sets the reader's source. Its folder is fixed: a second source must use the same one. */
async function setSource(payload: unknown, deps: CoreTestDeps): Promise<string | null> {
  const parsed = parsePayload(payload);
  if (!parsed) return 'payload';
  const source = await TestReaderSource.create(parsed);
  if (!source) return 'root';
  const current = deps.readerSource();
  if (current instanceof TestReaderSource && current.root !== source.root) return 'root changed';
  deps.setReaderSource(source);
  return null;
}

export function handleCoreTest(request: TestRequest, deps: CoreTestDeps): void {
  const markers = request.markers ?? '';
  const ok = (value?: number) =>
    deps.reply({
      type: 'result',
      reqId: request.reqId,
      ok: true,
      ...(value === undefined ? {} : { value }),
    });
  switch (request.action) {
    case 'hold':
      deps.state.holding = true;
      ok();
      return;
    case 'release': {
      deps.state.holding = false;
      const held = deps.state.held.splice(0);
      for (const open of held) deps.open(open);
      ok(held.length);
      return;
    }
    case 'held':
      ok(deps.state.held.length);
      return;
    case 'hold-opened':
      deps.state.holdingOpened = true;
      ok();
      return;
    case 'release-opened': {
      deps.state.holdingOpened = false;
      const held = deps.state.heldOpened.splice(0);
      for (const go of held) go();
      ok(held.length);
      return;
    }
    case 'held-opened':
      ok(deps.state.heldOpened.length);
      return;
    case 'file-opens':
      ok(deps.state.fileOpens);
      return;
    case 'searches':
      ok(deps.state.searches);
      return;
    case 'hold-searches':
      deps.state.holdingSearches = true;
      ok();
      return;
    case 'release-searches': {
      deps.state.holdingSearches = false;
      const held = deps.state.heldSearches.splice(0);
      for (const search of held) deps.runSearch(search);
      ok(held.length);
      return;
    }
    case 'held-searches':
      ok(deps.state.heldSearches.length);
      return;
    case 'hold-cards': {
      // Holds the cards queries anchored at a message; null lets the held ones go.
      const rowid = (request.payload as { rowid?: unknown } | undefined)?.rowid;
      if (rowid !== null && !(Number.isSafeInteger(rowid) && (rowid as number) > 0)) {
        deps.reply({ type: 'result', reqId: request.reqId, ok: false, code: 'invalid' });
        return;
      }
      deps.state.holdCardsAt = rowid as number | null;
      const held = rowid === null ? deps.state.heldCards.splice(0) : [];
      for (const go of held) go();
      ok(held.length);
      return;
    }
    case 'held-cards':
      ok(deps.state.heldCards.length);
      return;
    case 'release-writes': {
      const count = (request.payload as { count?: unknown } | undefined)?.count;
      const valid =
        count === null || (typeof count === 'number' && Number.isSafeInteger(count) && count > 0);
      if (!deps.writeGate || !valid) {
        deps.reply({ type: 'result', reqId: request.reqId, ok: false, code: 'invalid' });
        return;
      }
      deps.writeGate.release(count as number | null);
      ok();
      return;
    }
    case 'held-writes':
      ok(deps.writeGate?.held ?? 0);
      return;
    case 'log':
      deps.log.info('test.log', {
        subject: markers,
        path: markers,
        reason: markers,
        errorClass: markers,
      });
      ok();
      return;
    case 'error':
      deps.log.error('test.error', errorData(new Error(markers), deps.roots));
      ok();
      return;
    case 'throw':
      setTimeout(() => {
        throw new Error(markers);
      }, 0);
      ok();
      return;
    case 'reject':
      void Promise.reject(new Error(markers));
      ok();
      return;
    case 'worker-log':
    case 'worker-crash':
    case 'worker-reject':
      deps.toWorker({ type: 'test', action: request.action, markers });
      ok();
      return;
    case 'bench':
      import('./bench/core')
        .then((bench) => bench.handleBench(request.payload, deps.dir))
        .then(
          (data) => deps.reply({ type: 'result', reqId: request.reqId, ok: true, data }),
          (err: unknown) =>
            deps.reply({
              type: 'result',
              reqId: request.reqId,
              ok: false,
              code: 'invalid',
              detail: String((err as Error)?.message ?? err).slice(0, 200),
            }),
        );
      return;
    case READER_SOURCE_ACTION:
      void setSource(request.payload, deps).then((problem) =>
        problem === null
          ? ok()
          : deps.reply({
              type: 'result',
              reqId: request.reqId,
              ok: false,
              code: 'invalid',
              detail: problem,
            }),
      );
      return;
    case 'reader-limits': {
      const next = limits(request.payload);
      if (!next) {
        deps.reply({ type: 'result', reqId: request.reqId, ok: false, code: 'invalid' });
        return;
      }
      void deps.lane.setLimits(next).then(() => ok());
      return;
    }
    case READER_UNSANITIZED_ACTION:
      // Later opens serve HTML bodies without the sanitizer and the CSS filter.
      if (typeof request.payload !== 'boolean') {
        deps.reply({ type: 'result', reqId: request.reqId, ok: false, code: 'invalid' });
        return;
      }
      deps.state.unsanitized = request.payload;
      ok();
      return;
    case 'reader-lane':
      deps.reply({ type: 'result', reqId: request.reqId, ok: true, data: deps.lane.describe() });
      return;
    case 'reader-gate':
      // Lets the lookups waiting at the named gate go on; it stays open.
      if (typeof request.payload !== 'string') {
        deps.reply({ type: 'result', reqId: request.reqId, ok: false, code: 'invalid' });
        return;
      }
      ok(openGate(request.payload));
      return;
    case 'reader-gate-waiting':
      if (typeof request.payload !== 'string') {
        deps.reply({ type: 'result', reqId: request.reqId, ok: false, code: 'invalid' });
        return;
      }
      ok(waitingAt(request.payload));
      return;
    case 'reader-memory':
      // The reader worker's heap, and core's memory, which includes the worker's.
      // It always replies: without a worker, or with one that has ended, `worker` is null.
      void deps.lane
        .heapStatistics()
        .catch(() => null)
        .then((heap) => {
          const usage = process.memoryUsage();
          deps.reply({
            type: 'result',
            reqId: request.reqId,
            ok: true,
            data: {
              worker: heap && {
                used: heap.used_heap_size,
                external: heap.external_memory,
                total: heap.total_heap_size,
                limit: heap.heap_size_limit,
              },
              core: {
                rss: usage.rss,
                heapUsed: usage.heapUsed,
                external: usage.external,
                arrayBuffers: usage.arrayBuffers,
              },
            },
          });
        });
      return;
    case 'source-records': {
      const records = deps.session?.records ?? null;
      deps.reply({
        type: 'result',
        reqId: request.reqId,
        ok: true,
        data: records && {
          scans: records.scans,
          summary: records.summary,
          rejected: records.rejected.map((r) => ({ ...r })),
          stamp: deps.session?.gate.current ?? null,
          hasRoot: deps.session?.hasRoot ?? false,
        },
      });
      return;
    }
    case 'exit':
      ok();
      setTimeout(() => process.exit(3), 50);
      return;
    default:
      deps.reply({ type: 'result', reqId: request.reqId, ok: false, code: 'invalid' });
  }
}
