// SPDX-License-Identifier: AGPL-3.0-or-later
// The export run core serves. Core is started for one source at a time and
// stamps every piece of work with that source and its generation. Results go
// through the writer, which drops them if the generation moved on while they
// were in flight.

import { readdir } from 'node:fs/promises';
import type { CoreResult, CoreSource, IdentifyRequest, ScanRequest } from '../shared/core-protocol';
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

export class SourceSession {
  readonly gate = new GenerationGate();
  readonly records: SourceRecords = { scans: 0, rejected: [], summary: null };
  private root: string | null = null;
  private readonly writer: Writer<RunScan>;

  constructor(
    source: CoreSource | null,
    private readonly log: Logger,
    private readonly reply: (result: CoreResult) => void,
  ) {
    this.writer = new Writer(this.gate, (scan) => {
      this.records.scans += 1;
      this.records.rejected = scan.rejected;
      this.records.summary = summarize(scan);
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

  handle(request: IdentifyRequest | ScanRequest): void {
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
    if (root === null) {
      this.send({ type: 'result', reqId: request.reqId, ok: false, code: 'unavailable' });
      return;
    }
    const stamp: Stamp = { ...current };
    const work =
      request.type === 'identify'
        ? this.identify(request, root, stamp)
        : this.scan(request, root, stamp);
    work.catch(() => {
      this.send({ type: 'result', reqId: request.reqId, ok: false, code: 'unavailable', stamp });
    });
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
