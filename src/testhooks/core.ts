// SPDX-License-Identifier: AGPL-3.0-or-later
// Core-process test hooks: hold opens to keep them pending, push markers
// through every logging path, set the reader's source and limits, open the
// source's gates, report the reader's memory, and turn the unsanitized path
// on or off.

import type { ReaderLane } from '../core/reader/lane';
import type { ReaderSource } from '../core/reader/source';
import type {
  CoreResult,
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
  state: { holding: boolean; held: Array<OpenRequest | ReadRequest>; unsanitized: boolean };
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
