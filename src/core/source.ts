// SPDX-License-Identifier: AGPL-3.0-or-later
// The export run core serves. Core is started for one source at a time and
// stamps every piece of work with that source and its generation. Results go
// through the writer, which drops them if the generation moved on while they
// were in flight. The run's index opens once main asks for it, after a scan.
//
// Everything that opens, replaces or deletes the source's index goes through
// one lock, one operation at a time: opening it, recovering it when it turns
// out damaged, forgetting the source and resetting the app. Each starts with
// the teardown of the index there is (its work stopped and drained, its check
// joined, every connection closed), and nothing of a family is deleted while
// core holds a connection or a file descriptor on it. Callbacks that arrive
// later, such as the outcome of a check, are looked at again under the lock
// and dropped if their index is no longer the current one.

import { closeSync, fstatSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CoreEvent,
  CoreResult,
  CoreSource,
  ForgetRequest,
  IdentifyRequest,
  IndexQueryRequest,
  IndexRequest,
  ResetRequest,
  ScanRequest,
} from '../shared/core-protocol';
import type { EmlFile, IndexMatch, IndexOpened, IndexReport } from '../shared/index-types';
import { errorClassOf } from '../shared/log/schema';
import type { FileIdentity } from '../shared/reader-protocol';
import type { Logger } from '../shared/log/writer';
import type { ScanSummary } from '../shared/sources';
import {
  ContainmentError,
  addEntry,
  countRejections,
  emptyScan,
  openContained,
  openWithRescan,
  pairCounts,
  resolveRoot,
  type FileRef,
  type Rejection,
  type RunScan,
} from './containment';
import { GenerationGate, Writer, sameStamp, type Stamp } from './generation';
import { runIdentity } from './identity';
import { FamilyInUse, deleteFamily } from './index/family';
import type { CheckResult } from './index/ops';
import { ThreadError, type IndexThread, type ThreadRole } from './index/pool';
import { BODY_STATE, mismatchOf, probeIdentity } from './index/schema';
import { IndexBusy } from './index/sql';
import type { LocatedFile, OpenedMessage } from './reader/source';
import { overlaps } from '../shared/overlap';
import {
  ConnectionRegistry,
  IndexService,
  failureReason,
  type IndexOptions,
} from './index/service';
import { withScan } from './index/report';

/** Entries scanned between yields, so core keeps answering during a long scan. */
const SCAN_SLICE = 2000;
/** The shortest time between two reports of a scan's progress, in milliseconds. */
const SCAN_REPORT_MS = 250;

/**
 * How long the look at a damaged index's file waits for another connection's
 * lock. It runs on core's main thread, so it waits briefly: busy means the
 * open is refused, never that the file is damaged.
 */
const DAMAGED_PROBE_BUSY_MS = 100;

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * The open file is the one the index read: same device, inode, size and
 * modification time. A file rewritten in place keeps its inode, so the size
 * and time are what tell it apart.
 */
function isIndexedFile(fd: number, indexed: FileRef): boolean {
  const st = fstatSync(fd, { bigint: true });
  return (
    st.dev === indexed.dev &&
    st.ino === indexed.ino &&
    Number(st.size) === indexed.size &&
    st.mtimeNs === indexed.mtimeNs
  );
}

/**
 * A match whose stored body belongs to an older version of the file: the
 * body's matches go, and the other columns stay, until the file is indexed again.
 */
function unindexedBody(match: IndexMatch): IndexMatch {
  return { ...match, body: null, bodyMatches: 0, changed: true };
}

/**
 * The reader's open of a message file, or why there is none: no source or a
 * newer generation or open, the run unavailable, no such message, its file
 * missing, or a file the checks refused.
 */
export type ReaderFile =
  | { ok: true; opened: OpenedMessage; match?: IndexMatch | null }
  | {
      ok: false;
      code: 'no_source' | 'superseded' | 'unavailable' | 'not_found' | 'eml_missing' | 'refused';
      /** For `eml_missing` or `refused` from search: how the message matched. */
      match?: IndexMatch | null;
    };

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

/** Runs operations one at a time, in the order they were asked for. */
export class LifecycleLock {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(op: () => Promise<T> | T): Promise<T> {
    const next = this.tail.then(op, op);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/** Where the source's index lives and how its threads start. */
export interface IndexSetup {
  /** `<userData>/index`. */
  dir: string;
  thread: (role: ThreadRole) => IndexThread;
  options?: IndexOptions;
  /** The run folders of the other exports the app knows. */
  exports?: string[];
}

export class SourceSession {
  readonly gate = new GenerationGate();
  readonly records: SourceRecords = { scans: 0, rejected: [], summary: null };
  /** Every database connection core holds. */
  readonly connections = new ConnectionRegistry();
  readonly lock = new LifecycleLock();
  private root: string | null = null;
  private readonly writer: Writer<RunScan>;
  /** The run's scan, made once for this core's source and shared by whoever asks for it. */
  private scanning: Promise<RunScan | null> | null = null;
  /** Indexes whose phase 1 was started. */
  private readonly phase1Started = new WeakSet<IndexService>();
  /** The work the last index open left running: the scan, then phase 1's start. */
  private indexing: Promise<void> | null = null;
  /** The open source's index, once main asked for it. */
  index: IndexService | null = null;
  /** Main was told that this generation's index is damaged. */
  private damageReported = false;
  private opened: IndexOpened | null = null;
  /** Sources forgotten while core runs: nothing of theirs opens or is created again. */
  private readonly retired = new Set<string>();
  /** Closed for good by a reset: no open, rebuild or recovery starts. */
  private admitting = true;
  /** The run folders of the exports the app knows, this one included. */
  private readonly exportRoots: string[];

  constructor(
    source: CoreSource | null,
    private readonly log: Logger,
    private readonly reply: (result: CoreResult) => void,
    private readonly indexSetup: IndexSetup | null = null,
    private readonly emit: (event: CoreEvent) => void = () => {},
  ) {
    this.exportRoots = [...(source?.root ? [source.root] : []), ...(indexSetup?.exports ?? [])];
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
    work.catch((err: unknown) => {
      // Only the class and, for a thread's error, its reason: never a message.
      this.log.warn(
        'source.request_failed',
        {
          errorClass: errorClassOf(err),
          ...(err instanceof ThreadError ? { reason: failureReason(err.code) } : {}),
        },
        { src: stamp.sourceKey },
      );
      this.send({ type: 'result', reqId: request.reqId, ok: false, code: 'unavailable', stamp });
    });
  }

  /**
   * Whether an export the app knows overlaps the index folder now: lies
   * inside it, or holds it, with links resolved at this moment. Then no index
   * file is opened, made, replaced or deleted, so nothing of an export can be
   * changed. Asked right before each of those, never remembered.
   */
  private overlapsIndex(): boolean {
    const dir = this.indexSetup?.dir;
    return dir !== undefined && this.exportRoots.some((root) => overlaps(root, dir));
  }

  private dbPathOf(sourceKey: string): string | null {
    return this.indexSetup ? join(this.indexSetup.dir, `${sourceKey}.sqlite`) : null;
  }

  /**
   * True while `service` is the source's index, its generation is current and
   * no reset has closed core: a check result or a recovery waiting for the
   * lock has no effect otherwise.
   */
  private isLive(service: IndexService, stamp: Stamp): boolean {
    return (
      this.admitting &&
      this.index === service &&
      !service.isClosed &&
      this.gate.isCurrent(stamp) &&
      !this.retired.has(stamp.sourceKey)
    );
  }

  private newService(setup: IndexSetup, stamp: Stamp, root: string | null): IndexService {
    const service: IndexService = new IndexService({
      indexDir: setup.dir,
      stamp,
      root: root ?? '',
      log: this.log,
      thread: setup.thread,
      connections: this.connections,
      isCurrent: () => this.gate.isCurrent(stamp) && this.index === service,
      ...(setup.options ? { options: setup.options } : {}),
      exportRoots: this.exportRoots,
      onDamage: (reason) => void this.lock.run(() => this.recover(service, stamp, reason)),
      onChecked: (result, ms) => void this.lock.run(() => this.checked(service, stamp, result, ms)),
      onChange: () => {
        if (this.index === service) this.sendEvent(stamp, service.progress, false);
      },
    });
    return service;
  }

  /**
   * Opens the run's index (creating it if need be), answers with its identity
   * and starts phase 1 for the messages it doesn't have yet once the run is
   * scanned. It answers before the scan, so a stored list shows at once; the
   * scan runs outside the lock, so reads and a teardown don't wait for it.
   * While the run is
   * unavailable, only an existing index with the expected identity opens, for
   * browsing; nothing is created or indexed. One there that isn't this index
   * is damaged: it is deleted, and rebuilt once the run is back. One of
   * another schema version is kept as it is until then.
   */
  private async openIndex(request: IndexRequest, root: string | null, stamp: Stamp): Promise<void> {
    const failed = (code: 'invalid' | 'stale' | 'closed' | 'damaged' | 'unavailable') => {
      this.send({ type: 'result', reqId: request.reqId, ok: false, code, stamp });
      return false;
    };
    if (__PEV_TEST_HOOKS__) await this.indexSetup?.options?.beforeIndexOpen?.();
    const answered = await this.lock.run(async (): Promise<boolean> => {
      const setup = this.indexSetup;
      if (!setup) return failed('invalid');
      if (!this.admitting || this.retired.has(stamp.sourceKey)) return failed('closed');
      if (!this.gate.isCurrent(stamp)) return failed('stale');
      let service = this.index;
      if (!service) {
        // Opening can make or replace the index's files.
        if (this.overlapsIndex()) {
          this.log.warn('index.open_refused', { reason: 'overlap' }, { src: stamp.sourceKey });
          return failed('closed');
        }
        const fresh = this.newService(setup, stamp, root);
        let opened: IndexOpened;
        try {
          opened = await fresh.open(request.dbUuid, root !== null, {
            rebuild: request.rebuild === true,
          });
        } catch (err) {
          await fresh.close();
          if (err instanceof ThreadError && err.code === 'INDEX_OVERLAP') {
            // The writer found the overlap after the check above.
            this.log.warn('index.open_refused', { reason: 'overlap' }, { src: stamp.sourceKey });
            return failed('closed');
          }
          // Another connection held the index past the busy timeout: it may be
          // fine, so it is neither deleted nor rebuilt. The next open tries again.
          const busy = () => {
            this.log.warn('index.open_refused', { reason: 'busy' }, { src: stamp.sourceKey });
            return failed('unavailable');
          };
          if (err instanceof ThreadError && err.code === 'INDEX_BUSY') return busy();
          if (err instanceof ThreadError && err.code === 'INDEX_DAMAGED') {
            const dbPath = this.dbPathOf(stamp.sourceKey);
            let found: ReturnType<typeof probeIdentity>;
            try {
              found = dbPath ? probeIdentity(dbPath, DAMAGED_PROBE_BUSY_MS) : null;
            } catch (probeErr) {
              if (probeErr instanceof IndexBusy) return busy();
              throw probeErr;
            }
            const reason = (dbPath && mismatchOf(found, request.dbUuid)) || 'identity';
            if (reason === 'schema' && root === null) {
              // An index of another schema version is no damage: it stays as
              // it is while the export can't be read, and the next open with
              // the export there rebuilds it.
              this.log.info(
                'index.schema_pending',
                { schemaVersion: found?.version ?? 0 },
                { src: stamp.sourceKey },
              );
              return failed('unavailable');
            }
            this.log.warn('index.damaged', { reason }, { src: stamp.sourceKey });
            this.removeFamily(stamp.sourceKey, true);
            this.sendEvent(stamp, { ...fresh.progress, condition: 'damaged' }, true);
            return failed('damaged');
          }
          throw err;
        }
        this.index = fresh;
        this.opened = opened;
        service = fresh;
      }
      this.send({
        type: 'result',
        reqId: request.reqId,
        ok: true,
        stamp,
        index: this.opened!,
        progress: { ...service.progress },
      });
      return true;
    });
    if (!answered || root === null) return;
    this.indexing = (async () => {
      // A failed scan is answered to main's scan request, which reports it.
      const scan = await this.scanOnce(root, stamp).catch(() => null);
      if (scan) await this.startPhase1(stamp, scan);
    })();
    await this.indexing;
  }

  /** Resolves once what the last index open left running has ended: its scan, then phase 1. */
  async settled(): Promise<void> {
    await this.indexing;
    await this.index?.settled();
  }

  /** Starts indexing once both the index and the scan are there, and only once for an index. */
  private startPhase1(stamp: Stamp, scan: RunScan): Promise<void> {
    return this.lock.run(() => {
      const service = this.index;
      if (!service || !this.isLive(service, stamp) || this.phase1Started.has(service)) return;
      this.phase1Started.add(service);
      void service.startIndexing(scan);
    });
  }

  /**
   * The outcome of the check of an existing index, looked at under the lock:
   * dropped if the index it checked is gone or its generation moved on.
   */
  private checked(
    service: IndexService,
    stamp: Stamp,
    result: CheckResult | null,
    ms: number,
  ): void {
    if (!this.isLive(service, stamp)) {
      this.log.info('index.stale_dropped', { reason: 'generation' }, { src: stamp.sourceKey });
      return;
    }
    if (result?.ok === false) {
      // Recovery is queued behind this, on the same lock.
      const reason = result.reason;
      service.reportDamage(reason === 'identity' || reason === 'schema' ? reason : 'quick_check');
      return;
    }
    if (result?.ok) this.log.info('index.verified', { ms }, { src: stamp.sourceKey });
    else this.log.warn('index.unverified', { reason: 'worker_failed' }, { src: stamp.sourceKey });
    if (service.progress.condition === 'verifying') service.setCondition('ok');
  }

  /**
   * Recovers from a damaged index, under the lock: the code is logged, the
   * index is torn down and its files deleted, and main is told, so it can
   * rebuild under a new generation while the source is still known, or wait
   * for the run to come back. Dropped if the index is no longer the current one.
   */
  private async recover(service: IndexService, stamp: Stamp, reason: string): Promise<void> {
    if (!this.isLive(service, stamp)) {
      this.log.info('index.stale_dropped', { reason: 'generation' }, { src: stamp.sourceKey });
      return;
    }
    this.log.warn('index.damaged', { reason }, { src: stamp.sourceKey });
    await this.teardownIndex();
    // Whatever is left of it, if anything held on, goes when it is rebuilt.
    this.removeFamily(stamp.sourceKey, true);
    const condition = this.root === null ? 'damaged' : 'rebuilding';
    this.sendEvent(stamp, { ...service.progress, condition }, true);
  }

  /**
   * Tears the index down: it stops being current (its late results are
   * dropped), its queued jobs are cancelled, the write in flight rolls back,
   * the check is ended and joined, and every connection is closed.
   */
  private async teardownIndex(): Promise<void> {
    const service = this.index;
    this.index = null;
    this.opened = null;
    await service?.close();
  }

  /**
   * Deletes a source's index files. For the open source, only once core holds
   * no connection at all; for any source, only while no connection is listed
   * and no file descriptor is open on its files. Returns whether it deleted.
   */
  private removeFamily(sourceKey: string, own: boolean): boolean {
    const dbPath = this.dbPathOf(sourceKey);
    if (dbPath === null) return false;
    const refuse = (reason: 'in_use' | 'overlap' = 'in_use') => {
      this.log.warn('index.delete_refused', { reason }, { src: sourceKey });
      return false;
    };
    if (this.overlapsIndex()) return refuse('overlap');
    if (this.connections.holds(dbPath) || (own && this.connections.size > 0)) return refuse();
    try {
      deleteFamily(dbPath);
    } catch (err) {
      if (err instanceof FamilyInUse) return refuse();
      throw err;
    }
    this.log.info('index.deleted', {}, { src: sourceKey });
    return true;
  }

  /**
   * Main hears of a damaged index once, and that is the last it hears of this
   * generation's index: main rebuilds it under a new generation. A scan still
   * running here then reports nothing, so the damage isn't followed by
   * progress that shows the index as fine.
   */
  private sendEvent(stamp: Stamp, progress: IndexService['progress'], damaged: boolean): void {
    if (this.damageReported) return;
    if (damaged) this.damageReported = true;
    this.emit({ type: 'event', event: 'index', stamp, progress: { ...progress }, damaged });
  }

  /**
   * Forgets a source: from now on nothing of it opens, recovers or is
   * created in this process. Under the lock, its index is torn down if it is
   * the open one, then its files are deleted.
   */
  forget(request: ForgetRequest): Promise<void> {
    const key = request.sourceKey;
    this.retired.add(key);
    return this.lock.run(async () => {
      const own = this.gate.current?.sourceKey === key;
      if (own) await this.teardownIndex();
      const deleted = this.removeFamily(key, own);
      this.send(
        deleted
          ? { type: 'result', reqId: request.reqId, ok: true }
          : { type: 'result', reqId: request.reqId, ok: false, code: 'busy' },
      );
    });
  }

  /**
   * Closes core to every open, rebuild and recovery for good, then tears the
   * open source's index down under the lock, so the app's data can be deleted.
   */
  reset(request: ResetRequest): Promise<void> {
    this.admitting = false;
    return this.lock.run(async () => {
      await this.teardownIndex();
      const key = this.gate.current?.sourceKey;
      if (key) this.retired.add(key);
      const idle = this.connections.size === 0;
      this.send(
        idle
          ? { type: 'result', reqId: request.reqId, ok: true }
          : { type: 'result', reqId: request.reqId, ok: false, code: 'busy' },
      );
    });
  }

  private async query(request: IndexQueryRequest, stamp: Stamp): Promise<void> {
    const service = this.index;
    if (!service) {
      this.send({ type: 'result', reqId: request.reqId, ok: false, code: 'no_index', stamp });
      return;
    }
    // Rows from a damaged index may be wrong: none are given out.
    const damaged = () =>
      this.send({ type: 'result', reqId: request.reqId, ok: false, code: 'damaged', stamp });
    if (service.isDamaged) return damaged();
    let answer: Awaited<ReturnType<IndexService['ask']>>;
    try {
      answer = await service.ask(request.query);
      // The report adds what the last scan refused, which only the source holds.
      if (request.query.op === 'report' && answer !== null && typeof answer === 'object') {
        answer = withScan(answer as IndexReport, this.records.rejected, service.took);
      }
    } catch (err) {
      if (service.isDamaged) return damaged();
      throw err;
    }
    if (service.isDamaged) return damaged();
    this.send({
      type: 'result',
      reqId: request.reqId,
      ok: true,
      stamp,
      answer,
      progress: { ...service.progress },
    });
  }

  /**
   * The reader's source: the message file of an indexed message, under the
   * current generation, opened only through the contained open. A file that
   * changed since the scan is examined again and opened once more with its new
   * identity; a link, a FIFO or another file type is never opened. `stale`
   * tells whether a newer open has come in since, so nothing is opened for it.
   * With a search, the answer also says how the message matched it; when the
   * file opened isn't the one indexed, its stored body isn't used.
   */
  async openForReader(
    rowid: number,
    generation: number,
    stale: () => boolean,
    search?: string,
  ): Promise<ReaderFile> {
    const current = this.gate.current;
    if (!current) return { ok: false, code: 'no_source' };
    if (current.generation !== generation) return { ok: false, code: 'superseded' };
    const root = this.root;
    if (root === null) return { ok: false, code: 'unavailable' };
    const service = this.index;
    if (!service || service.isDamaged) return { ok: false, code: 'not_found' };
    const file = (await service.ask(
      search === undefined ? { op: 'eml', rowid } : { op: 'eml', rowid, search },
    )) as EmlFile | null;
    // Nothing is opened for a generation, an index or an open that moved on meanwhile.
    if (!this.gate.isCurrent(current) || this.index !== service || service.isDamaged || stale()) {
      return { ok: false, code: 'superseded' };
    }
    if (!file) return { ok: false, code: 'not_found' };
    // Only an open from search has a match, and only then does the answer carry one.
    const match = file.match;
    const withMatch = match === undefined ? {} : { match };
    if (file.rel === null || file.bodyState === BODY_STATE.emlMissing) {
      return { ok: false, code: 'eml_missing', ...withMatch };
    }
    const indexed: FileRef = {
      rel: file.rel,
      kind: 'eml',
      dev: BigInt(file.dev),
      ino: BigInt(file.ino),
      size: file.size,
      mtimeNs: BigInt(file.mtimeNs),
    };
    const opened = openWithRescan(root, indexed);
    if (!opened.ok) {
      this.log.info('open.file_refused', {
        reason: opened.gone ? 'eml_missing' : opened.rejection.kind,
      });
      return { ok: false, code: opened.gone ? 'eml_missing' : 'refused', ...withMatch };
    }
    const fd = opened.fd;
    let indexedFile: boolean;
    try {
      indexedFile = !match || isIndexedFile(fd, indexed);
    } catch {
      // The open file can't be checked: it is closed, and refused like one that can't be opened.
      try {
        closeSync(fd);
      } catch {
        // Closed already.
      }
      this.log.info('open.file_refused', { reason: 'unreadable' });
      return { ok: false, code: 'refused', ...withMatch };
    }
    const changed = match && !indexedFile;
    return {
      ok: true,
      ...(changed ? { match: unindexedBody(match) } : withMatch),
      opened: {
        input: { kind: 'fd', fd },
        file: { dev: opened.ref.dev.toString(), ino: opened.ref.ino.toString() },
        close: () => {
          closeSync(fd);
          return Promise.resolve();
        },
      },
    };
  }

  /**
   * The path of a message's file for Show in folder, only while the file at
   * the pair's path is still the one a view was read from: a contained open
   * (no links, a regular file) whose `(dev, ino)` is that identity. A replaced
   * file is never shown in place of the one that was read.
   */
  async locateForReader(
    rowid: number,
    generation: number,
    want: FileIdentity,
  ): Promise<LocatedFile> {
    const current = this.gate.current;
    if (!current) return { ok: false, code: 'no_source' };
    if (current.generation !== generation) return { ok: false, code: 'superseded' };
    const root = this.root;
    if (root === null) return { ok: false, code: 'unavailable' };
    const service = this.index;
    if (!service || service.isDamaged) return { ok: false, code: 'not_found' };
    const file = (await service.ask({ op: 'eml', rowid })) as EmlFile | null;
    if (!this.gate.isCurrent(current) || this.index !== service || service.isDamaged) {
      return { ok: false, code: 'superseded' };
    }
    if (!file) return { ok: false, code: 'not_found' };
    if (file.rel === null || file.bodyState === BODY_STATE.emlMissing) {
      return { ok: false, code: 'eml_missing' };
    }
    let fd: number;
    try {
      fd = openContained(root, {
        rel: file.rel,
        kind: 'eml',
        dev: BigInt(want.dev),
        ino: BigInt(want.ino),
        size: file.size,
        mtimeNs: BigInt(file.mtimeNs),
      });
    } catch (err) {
      if (!(err instanceof ContainmentError)) throw err;
      return { ok: false, code: err.errno === 'ENOENT' ? 'eml_missing' : 'changed' };
    }
    closeSync(fd);
    return { ok: true, path: join(root, file.rel) };
  }

  /**
   * Looks at every entry of the run folder, and reports how far it got: once
   * the folder is listed, then at most every SCAN_REPORT_MS, and at the end.
   */
  private async scanEntries(root: string, stamp: Stamp): Promise<RunScan> {
    if (__PEV_TEST_HOOKS__) await this.indexSetup?.options?.beforeScan?.();
    const names = await readdir(root);
    const scan = emptyScan(root);
    let reported = 0;
    const report = (done: number) => {
      reported = performance.now();
      this.sendEvent(
        stamp,
        {
          phase: 'scanning',
          loaded: done,
          total: names.length,
          failed: 0,
          timeouts: 0,
          capped: 0,
          // An index opened first keeps its own condition, e.g. while it is rebuilt.
          condition: this.index?.progress.condition ?? 'ok',
          // Phase 2 waits for phase 1, which waits for this scan.
          bodyPhase: 'waiting',
          bodiesDone: 0,
          bodiesTotal: 0,
          bodiesFailed: 0,
        },
        false,
      );
    };
    report(0);
    for (let i = 0; i < names.length; i += 1) {
      addEntry(scan, names[i]!);
      if (i % SCAN_SLICE === SCAN_SLICE - 1) {
        if (performance.now() - reported >= SCAN_REPORT_MS) report(i + 1);
        await yieldToLoop();
      }
    }
    report(names.length);
    // Test builds can hold the scan here too, with everything listed.
    if (__PEV_TEST_HOOKS__) await this.indexSetup?.options?.beforeScan?.();
    return scan;
  }

  /**
   * The run's scan: made once, by whichever of the index open and main's scan
   * request comes first, and logged once. Null when the generation moved on.
   */
  private scanOnce(root: string, stamp: Stamp): Promise<RunScan | null> {
    this.scanning ??= (async () => {
      const started = performance.now();
      const scan = await this.scanEntries(root, stamp);
      if (!this.writer.submit(stamp, scan)) {
        this.log.info(
          'writer.stale_dropped',
          { generation: stamp.generation, count: 1 },
          { src: stamp.sourceKey },
        );
        return null;
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
      return scan;
    })();
    return this.scanning;
  }

  /** Tears the index down, under the lock. */
  close(): Promise<void> {
    return this.lock.run(() => this.teardownIndex());
  }

  private async identify(request: IdentifyRequest, root: string, stamp: Stamp): Promise<void> {
    const identity = await runIdentity(root);
    this.send({ type: 'result', reqId: request.reqId, ok: true, stamp, identity });
  }

  private async scan(request: ScanRequest, root: string, stamp: Stamp): Promise<void> {
    const scan = await this.scanOnce(root, stamp);
    if (!scan) {
      this.send({ type: 'result', reqId: request.reqId, ok: false, code: 'stale', stamp });
      return;
    }
    this.send({ type: 'result', reqId: request.reqId, ok: true, stamp, scan: summarize(scan) });
    // Phase 1 starts here if the index opened first.
    await this.startPhase1(stamp, scan);
  }

  private send(result: CoreResult): void {
    this.reply(result);
  }
}
