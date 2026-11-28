// SPDX-License-Identifier: AGPL-3.0-or-later
// Core utility process. It owns the reader lane and answers main over a MessagePort.

import { join, sep } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { MessagePortMain } from 'electron';
import { ASSET_SCHEME, VIEW_HOST } from '../shared/constants';
import type {
  CoreInit,
  CoreRequest,
  CoreResult,
  IndexQueryRequest,
  OpenRequest,
  ProofFileRead,
  WorkerMessage,
  WorkerRequest,
} from '../shared/core-protocol';
import type { IndexMatch } from '../shared/index-types';
import { errorData } from '../shared/log/schema';
import { LogWriter, type Logger } from '../shared/log/writer';
import type {
  LocateRequest,
  ReadRequest,
  ReaderFailure,
  ReaderMatch,
  StoredBody,
} from '../shared/reader-protocol';
import { WorkerThread, type ThreadRole } from './index/pool';
import type { IndexOptions } from './index/service';
import { READER_RETIRE_MB, ReaderLane } from './reader/lane';
import { OpenTracker } from './reader/opens';
import { readSource } from './reader/source-read';
import type { LocatedFile, ReaderSource } from './reader/source';
import { SourceSession, type ReaderFile } from './source';

process.umask(0o077);

let log: LogWriter | null = null;
let workerLog: Logger | null = null;
let roots: Array<[string, string]> = [];
let port: MessagePortMain | null = null;
/** Where the reader opens messages from. Only builds with test hooks set one for now. */
let readerSource: ReaderSource | null = null;

const lane = new ReaderLane<WorkerRequest, WorkerMessage>({
  spawn: (heapMb) =>
    new Worker(join(import.meta.dirname, 'core-worker.js'), {
      workerData: { appRoot: roots[0]?.[0] ?? '' },
      resourceLimits: { maxOldGenerationSizeMb: heapMb },
    }),
  onSpawn: () => log?.info('core.worker_spawn'),
  // Only an exit the lane didn't plan is a warning.
  onExit: (exitCode, planned) =>
    planned
      ? log?.info('core.worker_exit', { exitCode })
      : log?.warn('core.worker_exit', { exitCode }),
  onError: (err) => log?.error('core.worker_error', errorData(err, roots)),
  onBreach: (breach, ms) =>
    log?.warn(breach === 'timeout' ? 'reader.timeout' : 'reader.limit', { ms }),
  // A large message can leave the worker holding hundreds of MB: a new worker gives it back.
  retire: (message) =>
    (message.type === 'rendered' || message.type === 'sourced') &&
    message.heldBytes > READER_RETIRE_MB * 1024 * 1024,
  onRetire: (message) =>
    log?.info('reader.worker_retired', {
      bytes: message.type === 'rendered' || message.type === 'sourced' ? message.heldBytes : 0,
    }),
  onOther: (message) => {
    if (message.type === 'log') workerLog?.log(message.level, message.code, message.data);
  },
});
let session: SourceSession | null = null;

/** Test builds can hold opens in core to keep them pending. */
const testState = {
  holding: false,
  held: [] as Array<OpenRequest | ReadRequest>,
  /** Message files opened for the reader. */
  fileOpens: 0,
  unsanitized: false,
  /** Stored bodies go to the reader worker with ranges that fail its check. */
  breakMarks: false,
  /** Searches that reached core. */
  searches: 0,
  /** Searches and snippet requests are held, to answer them late. */
  holdingSearches: false,
  heldSearches: [] as IndexQueryRequest[],
  /** Holds reads once their message file is open, before the parse. */
  holdingOpened: false,
  heldOpened: [] as Array<() => void>,
  /** Holds the shell's cards queries anchored at this message, until a test lets them go. */
  holdCardsAt: null as number | null,
  heldCards: [] as Array<() => void>,
};
/** Test builds can hold phase 1's writes. */
let writeGate: import('../testhooks/core').WriteGate | null = null;
let scanGate: import('../testhooks/core').WriteGate | null = null;
let indexGate: import('../testhooks/core').WriteGate | null = null;
let recentGate: import('../testhooks/core').RecentGate | null = null;

process.on('uncaughtException', (err) => log?.error('core.uncaught', errorData(err, roots)));
process.on('unhandledRejection', (reason) =>
  log?.error('core.rejection', errorData(reason, roots)),
);

function reply(result: CoreResult): void {
  port?.postMessage(result);
}

/** Old-generation heap limit of the index's threads, in MB. */
const INDEX_THREAD_HEAP_MB = 128;

/** Starts one of the index's threads: the writer, the query thread or a pool thread. */
function indexThread(role: ThreadRole): WorkerThread {
  return new WorkerThread(
    () =>
      new Worker(join(import.meta.dirname, 'index-worker.js'), {
        workerData: { role },
        resourceLimits: { maxOldGenerationSizeMb: INDEX_THREAD_HEAP_MB },
      }),
  );
}

/** Folder-access proof (test builds): has the worker read files, as request `reqId`. */
async function workerRead(reqId: number, paths: string[]): Promise<ProofFileRead[] | null> {
  const message = await lane.call({ type: 'proof-read', reqId, paths });
  return message?.type === 'proof-read' ? message.reads : null;
}

/** Test builds only: builds one of the test hooks' fixed placeholder bodies. */
function build(request: OpenRequest): void {
  const { reqId, stubId, token } = request;
  void lane.job({ type: 'build', reqId, stubId, token }).then((outcome) => {
    const message = outcome.ok ? outcome.message : null;
    if (message?.type === 'result' && message.ok) {
      reply({ type: 'result', reqId, ok: true, body: message.body });
    } else {
      reply({ type: 'result', reqId, ok: false, code: 'invalid' });
    }
  });
}

/** Each window's newest open, while one of its opens is under way. */
const opens = new OpenTracker();

/** The message to read: from the test source if a test set one, else from the open export. */
async function openForRead(
  request: Pick<ReadRequest, 'rowid' | 'generation' | 'search'>,
  stale: () => boolean,
): Promise<ReaderFile | { ok: false; code: 'no_source' }> {
  if (__PEV_TEST_HOOKS__ && readerSource) {
    const opened = await readerSource.open(request.rowid).catch(() => null);
    return opened ? { ok: true, opened } : { ok: false, code: 'not_found' };
  }
  if (!session) return { ok: false, code: 'no_source' };
  return session
    .openForReader(request.rowid, request.generation, stale, request.search)
    .catch((): ReaderFile => ({ ok: false, code: 'not_found' }));
}

/** Finds the file a view was read from, for Show in folder: from the test source or the open export. */
async function locate(request: LocateRequest): Promise<void> {
  const { reqId, rowid, generation, file } = request;
  let found: LocatedFile;
  if (__PEV_TEST_HOOKS__ && readerSource) {
    found = await readerSource
      .locate(rowid, file)
      .catch((): LocatedFile => ({ ok: false, code: 'not_found' }));
  } else if (!session) {
    found = { ok: false, code: 'no_source' };
  } else {
    found = await session
      .locateForReader(rowid, generation, file)
      .catch((): LocatedFile => ({ ok: false, code: 'not_found' }));
  }
  if (found.ok) reply({ type: 'result', reqId, ok: true, path: found.path });
  else reply({ type: 'result', reqId, ok: false, code: found.code });
}

/** What main and the shell learn of a match: counts and column names, never text. */
function readerMatch(match: IndexMatch | null | undefined): ReaderMatch | undefined {
  if (!match) return undefined;
  const { state, reason, columns, bodyMatches, changed } = match;
  return { state, reason, columns, bodyMatches, changed };
}

/** The stored body as the reader worker gets it; test builds can break its ranges. */
function testStored(stored: StoredBody): StoredBody {
  if (__PEV_TEST_HOOKS__ && testState.breakMarks) {
    // Every range moves past the text's end, so each fails the check and their number stays.
    const end = stored.text.length;
    return { text: stored.text, ranges: stored.ranges.map((): [number, number] => [end, end + 1]) };
  }
  return stored;
}

/** Answers a read that failed; the fallback and a missing file carry the match. */
type ReadFail = (
  code: 'no_source' | 'not_found' | 'superseded' | 'unavailable' | 'eml_missing' | 'reader_failed',
  reason?: ReaderFailure,
) => void;

/**
 * Opens one message and renders it in the reader lane. Of a window's opens,
 * one is rendered and the newest waits; an older one ends as superseded, and
 * nothing is opened for it once a newer one has come in.
 */
async function read(request: ReadRequest): Promise<void> {
  const open = opens.begin(request.lane, request.openId);
  try {
    await readOpen(request, open.stale);
  } finally {
    open.end();
  }
}

/** The part of `read` between taking its place among the window's opens and leaving it. */
async function readOpen(request: ReadRequest, stale: () => boolean): Promise<void> {
  const { reqId } = request;
  const found = await openForRead(request, stale);
  const indexMatch = 'match' in found ? found.match : null;
  const match = readerMatch(indexMatch);
  const fail: ReadFail = (code, reason) => {
    const carries = match && (code === 'reader_failed' || code === 'eml_missing');
    reply({
      type: 'result',
      reqId,
      ok: false,
      code,
      ...(reason ? { reason } : {}),
      ...(carries ? { match } : {}),
    });
  };
  if (!found.ok) return found.code === 'refused' ? fail('reader_failed', 'file') : fail(found.code);
  if (__PEV_TEST_HOOKS__) testState.fileOpens += 1;
  const opened = found.opened;
  const stored = indexMatch?.body ?? null;
  try {
    if (__PEV_TEST_HOOKS__ && testState.holdingOpened) {
      await new Promise<void>((resolve) => testState.heldOpened.push(resolve));
    }
    const outcome = await lane.job(
      {
        type: 'render',
        reqId,
        input: opened.input,
        mode: request.mode,
        assetBase: `${ASSET_SCHEME}://${VIEW_HOST}/${request.token}`,
        ...(__PEV_TEST_HOOKS__ && testState.unsanitized ? { unsanitized: true as const } : {}),
        ...(stored ? { stored: testStored(stored) } : {}),
      },
      { key: request.lane, order: request.openId },
    );
    if (!outcome.ok) {
      return outcome.reason === 'superseded'
        ? fail('superseded')
        : fail('reader_failed', outcome.reason);
    }
    const message = outcome.message;
    if (message.type !== 'rendered') return fail('reader_failed', 'crash');
    if (!message.ok) return fail('reader_failed', 'parse');
    reply({
      type: 'result',
      reqId,
      ok: true,
      read: message.message,
      file: opened.file,
      ...(match ? { match } : {}),
    });
  } finally {
    await opened.close().catch(() => undefined);
  }
}

function startOpen(request: OpenRequest | ReadRequest): void {
  if (request.type === 'read') void read(request);
  else if (__PEV_TEST_HOOKS__) build(request);
  else reply({ type: 'result', reqId: request.reqId, ok: false, code: 'invalid' });
}

function handle(request: CoreRequest): void {
  switch (request.type) {
    case 'open':
    case 'read':
      if (__PEV_TEST_HOOKS__ && testState.holding) {
        testState.held.push(request);
        return;
      }
      startOpen(request);
      return;
    case 'ping':
      reply({ type: 'result', reqId: request.reqId, ok: true });
      return;
    case 'test':
      if (__PEV_TEST_HOOKS__) {
        void import('../testhooks/core').then((hooks) =>
          hooks.handleCoreTest(request, {
            log: log as LogWriter,
            roots,
            state: testState,
            open: startOpen,
            toWorker: (message) => lane.post(message),
            reply,
            dir: import.meta.dirname,
            lane,
            setReaderSource: (source) => {
              readerSource = source;
            },
            readerSource: () => readerSource,
            session,
            writeGate,
            scanGate,
            indexGate,
            recentGate,
            runSearch: (held) => {
              if (session) session.handle(held);
              else reply({ type: 'result', reqId: held.reqId, ok: false, code: 'no_source' });
            },
          }),
        );
        return;
      }
      reply({ type: 'result', reqId: request.reqId, ok: false, code: 'invalid' });
      return;
    case 'proof':
      if (__PEV_TEST_HOOKS__) {
        void import('../testhooks/proof/core').then((hooks) =>
          hooks.handleProof(request, {
            reply,
            workerRead: (paths) => workerRead(request.reqId, paths),
          }),
        );
        return;
      }
      reply({ type: 'result', reqId: request.reqId, ok: false, code: 'invalid' });
      return;
    case 'locate':
      void locate(request);
      return;
    case 'source':
      void readSource(request, {
        open: (r) => openForRead(r, () => false),
        job: (message, slot) => lane.job(message, slot),
        reply,
      });
      return;
    case 'identify':
    case 'scan':
    case 'index':
    case 'index-query':
    case 'recent':
      if (__PEV_TEST_HOOKS__ && request.type === 'index-query') {
        const { op } = request.query;
        if (op === 'search') testState.searches += 1;
        if ((op === 'search' || op === 'snippets') && testState.holdingSearches) {
          testState.heldSearches.push(request);
          return;
        }
      }
      if (!session) {
        reply({ type: 'result', reqId: request.reqId, ok: false, code: 'no_source' });
        return;
      }
      if (
        __PEV_TEST_HOOKS__ &&
        request.type === 'index-query' &&
        request.query.op === 'cards' &&
        testState.holdCardsAt !== null &&
        request.query.anchor.rowid === testState.holdCardsAt
      ) {
        const held = session;
        testState.heldCards.push(() => held.handle(request));
        return;
      }
      session.handle(request);
      return;
    case 'forget':
    case 'reset':
      if (!session) {
        reply({ type: 'result', reqId: request.reqId, ok: false, code: 'no_source' });
        return;
      }
      void (request.type === 'forget' ? session.forget(request) : session.reset(request));
      return;
  }
}

process.parentPort.once('message', (event) => void init(event));

async function init(event: Electron.MessageEvent): Promise<void> {
  const init = event.data as CoreInit;
  roots = [[init.appRoot + sep, '']];
  log = new LogWriter(init.logsDir, 'core', 'core');
  workerLog = log.forProc('worker');
  let options: IndexOptions | undefined;
  if (__PEV_TEST_HOOKS__ && init.test) {
    const hooks = await import('../testhooks/core');
    writeGate = new hooks.WriteGate(init.test.holdWrites === true);
    scanGate = new hooks.WriteGate(init.test.holdScans === true);
    indexGate = new hooks.WriteGate(init.test.holdIndexOpens === true);
    options = {
      ...(init.test.batchPairs ? { batchPairs: init.test.batchPairs } : {}),
      ...(init.test.txnBytes ? { txnBytes: init.test.txnBytes } : {}),
      ...(init.test.jobMs ? { jobMs: init.test.jobMs } : {}),
      ...(init.test.stallBodyOf ? { stallBodyOf: init.test.stallBodyOf } : {}),
      readByName: init.test.readByName === true,
      beforeWrite: writeGate.beforeWrite,
      beforeScan: scanGate.beforeWrite,
      beforeIndexOpen: indexGate.beforeWrite,
    };
  }
  if (__PEV_TEST_HOOKS__) {
    const hooks = await import('../testhooks/core');
    recentGate = new hooks.RecentGate();
    options = { ...options, recentHooks: recentGate.hooks };
  }
  session = new SourceSession(
    init.source,
    log,
    reply,
    {
      dir: init.indexDir,
      thread: indexThread,
      exports: init.exports,
      ...(options ? { options } : {}),
    },
    (event) => port?.postMessage(event),
  );
  const p = event.ports[0];
  if (!p) return;
  port = p;
  port.on('message', (message) => handle(message.data as CoreRequest));
  port.start();
  lane.start();
  port.postMessage({ type: 'ready' });
}
