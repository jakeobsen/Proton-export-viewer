// SPDX-License-Identifier: AGPL-3.0-or-later
// The export run core serves. Core is started for one source at a time and
// stamps every piece of work with that source and its generation. Results go
// through the writer, which drops them if the generation moved on while they
// were in flight. The run's index opens once main asks for it, after a scan.

import { readdir } from 'node:fs/promises';
import type {
  CoreResult,
  CoreSource,
  IdentifyRequest,
  IndexQueryRequest,
  IndexRequest,
  ScanRequest,
} from '../shared/core-protocol';
import type { IndexOpened } from '../shared/index-types';
import type { Logger } from '../shared/log/writer';
import type { ScanSummary } from '../shared/sources';
import {
  ContainmentError,
  addEntry,
  countRejections,
  emptyScan,
  pairCounts,
  resolveRoot,
  type Rejection,
  type RunScan,
} from './containment';
import { GenerationGate, Writer, sameStamp, type Stamp } from './generation';
import { runIdentity } from './identity';
import type { IndexThread, ThreadRole } from './index/pool';
import { IndexService, type IndexOptions } from './index/service';

/** Entries scanned between yields, so core keeps answering during a long scan. */
const SCAN_SLICE = 2000;

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** What the writer keeps about the open source until the index takes it over. */
export interface SourceRecords {
  scans: number;
  rejected: Rejection[];
  summary: ScanSummary | null;
}

export function summarize(scan: RunScan): ScanSummary {
  return {
    ...pairCounts(scan),
    labels: scan.labels !== null,
    ignored: scan.ignored,
    rejected: countRejections(scan.rejected),
  };
}

/** Where the source's index lives and how its threads start. */
export interface IndexSetup {
  /** `<userData>/index`. */
  dir: string;
  thread: (role: ThreadRole) => IndexThread;
  options?: IndexOptions;
}

export class SourceSession {
  readonly gate = new GenerationGate();
  readonly records: SourceRecords = { scans: 0, rejected: [], summary: null };
  private root: string | null = null;
  private readonly writer: Writer<RunScan>;
  /** The last scan the writer accepted. */
  private lastScan: RunScan | null = null;
  /** The open source's index, once main asked for it. */
  index: IndexService | null = null;
  private indexOpening: Promise<IndexService> | null = null;
  private opened: IndexOpened | null = null;

  constructor(
    source: CoreSource | null,
    private readonly log: Logger,
    private readonly reply: (result: CoreResult) => void,
    private readonly indexSetup: IndexSetup | null = null,
  ) {
    this.writer = new Writer(this.gate, (scan) => {
      this.records.scans += 1;
      this.records.rejected = scan.rejected;
      this.records.summary = summarize(scan);
      this.lastScan = scan;
    });
    if (!source) return;
    this.gate.set({ sourceKey: source.sourceKey, generation: source.generation });
    if (source.root !== null) {
      // Main hands over the canonical path of the run. If it resolves anywhere
      // else now, a link was put on the way, and the run isn't used.
      try {
        const root = resolveRoot(source.root);
        if (root === source.root) this.root = root;
      } catch (err) {
        if (!(err instanceof ContainmentError)) throw err;
      }
      if (this.root === null) {
        this.log.warn('source.unavailable', { reason: 'unknown' }, { src: source.sourceKey });
      }
    }
  }

  get hasRoot(): boolean {
    return this.root !== null;
  }

  handle(request: IdentifyRequest | ScanRequest | IndexRequest | IndexQueryRequest): void {
    const current = this.gate.current;
    if (!current) {
      this.send({ type: 'result', reqId: request.reqId, ok: false, code: 'no_source' });
      return;
    }
    if (!sameStamp(request.stamp, current)) {
      this.send({ type: 'result', reqId: request.reqId, ok: false, code: 'stale', stamp: current });
      return;
    }
    const root = this.root;
    const stamp: Stamp = { ...current };
    // An unavailable run can still be browsed from its index.
    if (root === null && request.type !== 'index' && request.type !== 'index-query') {
      this.send({ type: 'result', reqId: request.reqId, ok: false, code: 'unavailable' });
      return;
    }
    const work =
      request.type === 'identify'
        ? this.identify(request, root!, stamp)
        : request.type === 'scan'
          ? this.scan(request, root!, stamp)
          : request.type === 'index'
            ? this.openIndex(request, root, stamp)
            : this.query(request, stamp);
    work.catch(() => {
      this.send({ type: 'result', reqId: request.reqId, ok: false, code: 'unavailable', stamp });
    });
  }

  /**
   * Opens the run's index (creating it if need be), answers with its identity
   * and starts phase 1 for the messages it doesn't have yet. While the run is
   * unavailable, only an existing index with the expected identity opens, for
   * browsing; nothing is created, deleted or indexed.
   */
  private async openIndex(request: IndexRequest, root: string | null, stamp: Stamp): Promise<void> {
    const setup = this.indexSetup;
    if (!setup) {
      this.send({ type: 'result', reqId: request.reqId, ok: false, code: 'invalid', stamp });
      return;
    }
    if (!this.indexOpening) {
      const service = new IndexService({
        indexDir: setup.dir,
        stamp,
        root: root ?? '',
        log: this.log,
        thread: setup.thread,
        isCurrent: () => this.gate.isCurrent(stamp),
        ...(setup.options ? { options: setup.options } : {}),
      });
      this.indexOpening = service.open(request.dbUuid, root !== null).then((opened) => {
        this.index = service;
        this.opened = opened;
        return service;
      });
      this.indexOpening.catch(() => {
        this.indexOpening = null;
        void service.close();
      });
    }
    const service = await this.indexOpening;
    if (root === null) {
      this.send({
        type: 'result',
        reqId: request.reqId,
        ok: true,
        stamp,
        index: this.opened!,
        progress: { ...service.progress },
      });
      return;
    }
    const scan = this.lastScan ?? (await this.scanNow(root, stamp));
    if (!this.gate.isCurrent(stamp) || !scan) {
      this.send({ type: 'result', reqId: request.reqId, ok: false, code: 'stale', stamp });
      return;
    }
    this.send({
      type: 'result',
      reqId: request.reqId,
      ok: true,
      stamp,
      index: this.opened!,
      progress: { ...service.progress },
    });
    void service.startPhase1(scan);
  }

  private async query(request: IndexQueryRequest, stamp: Stamp): Promise<void> {
    const service = this.index;
    if (!service) {
      this.send({ type: 'result', reqId: request.reqId, ok: false, code: 'no_index', stamp });
      return;
    }
    const answer = await service.ask(request.query);
    this.send({
      type: 'result',
      reqId: request.reqId,
      ok: true,
      stamp,
      answer,
      progress: { ...service.progress },
    });
  }

  /** Scans the run for the index when no scan was accepted yet. */
  private async scanNow(root: string, stamp: Stamp): Promise<RunScan | null> {
    const names = await readdir(root);
    const scan = emptyScan(root);
    for (let i = 0; i < names.length; i += 1) {
      addEntry(scan, names[i]!);
      if (i % SCAN_SLICE === SCAN_SLICE - 1) await yieldToLoop();
    }
    return this.writer.submit(stamp, scan) ? scan : null;
  }

  /** Ends the index's threads; their connections close with them. */
  async close(): Promise<void> {
    const opening = this.indexOpening;
    this.indexOpening = null;
    const service = await opening?.catch(() => null);
    await service?.close();
    this.index = null;
  }

  private async identify(request: IdentifyRequest, root: string, stamp: Stamp): Promise<void> {
    const identity = await runIdentity(root);
    this.send({ type: 'result', reqId: request.reqId, ok: true, stamp, identity });
  }

  private async scan(request: ScanRequest, root: string, stamp: Stamp): Promise<void> {
    const started = performance.now();
    const names = await readdir(root);
    const scan = emptyScan(root);
    for (let i = 0; i < names.length; i += 1) {
      addEntry(scan, names[i]!);
      if (i % SCAN_SLICE === SCAN_SLICE - 1) await yieldToLoop();
    }
    if (!this.writer.submit(stamp, scan)) {
      this.log.info(
        'writer.stale_dropped',
        { generation: stamp.generation, count: 1 },
        { src: stamp.sourceKey },
      );
      this.send({ type: 'result', reqId: request.reqId, ok: false, code: 'stale', stamp });
      return;
    }
    const summary = summarize(scan);
    this.log.info(
      'scan.done',
      { count: summary.pairs, ms: Math.round(performance.now() - started) },
      { src: stamp.sourceKey },
    );
    for (const [kind, count] of Object.entries(summary.rejected)) {
      if (count > 0)
        this.log.info('scan.rejected', { reason: kind, count }, { src: stamp.sourceKey });
    }
    this.send({ type: 'result', reqId: request.reqId, ok: true, stamp, scan: summary });
  }

  private send(result: CoreResult): void {
    this.reply(result);
  }
}
