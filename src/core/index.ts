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
  OpenRequest,
  ProofFileRead,
  WorkerMessage,
  WorkerRequest,
} from '../shared/core-protocol';
import { errorData } from '../shared/log/schema';
import { LogWriter, type Logger } from '../shared/log/writer';
import type { ReadRequest, ReaderFailure } from '../shared/reader-protocol';
import { ReaderLane } from './reader/lane';
import type { ReaderSource } from './reader/source';

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
  onExit: (exitCode) => log?.warn('core.worker_exit', { exitCode }),
  onError: (err) => log?.error('core.worker_error', errorData(err, roots)),
  onBreach: (breach, ms) =>
    log?.warn(breach === 'timeout' ? 'reader.timeout' : 'reader.limit', { ms }),
  onOther: (message) => {
    if (message.type === 'log') workerLog?.log(message.level, message.code, message.data);
  },
});

/** Test builds can hold opens in core to keep them pending. */
const testState = { holding: false, held: [] as Array<OpenRequest | ReadRequest> };

process.on('uncaughtException', (err) => log?.error('core.uncaught', errorData(err, roots)));
process.on('unhandledRejection', (reason) =>
  log?.error('core.rejection', errorData(reason, roots)),
);

function reply(result: CoreResult): void {
  port?.postMessage(result);
}

/** Folder-access proof (test builds): has the worker read files, as request `reqId`. */
async function workerRead(reqId: number, paths: string[]): Promise<ProofFileRead[] | null> {
  const message = await lane.call({ type: 'proof-read', reqId, paths });
  return message?.type === 'proof-read' ? message.reads : null;
}

/** Builds a fixed placeholder body. */
function build(request: OpenRequest): void {
  const { reqId, stubId, token } = request;
  void lane.job({ type: 'build', reqId, stubId, token }).then((outcome) => {
    const message = outcome.ok ? outcome.message : null;
    if (message?.type === 'result' && message.ok) {
      reply({ type: 'result', reqId, ok: true, body: message.body });
    } else {
      reply({ type: 'result', reqId, ok: false, code: 'unknown_stub' });
    }
  });
}

/** Opens one message from the reader source and renders it in the reader lane. */
async function read(request: ReadRequest): Promise<void> {
  const { reqId } = request;
  const fail = (
    code: 'no_source' | 'not_found' | 'superseded' | 'reader_failed',
    reason?: ReaderFailure,
  ) => reply({ type: 'result', reqId, ok: false, code, ...(reason ? { reason } : {}) });
  if (!readerSource) return fail('no_source');
  const opened = await readerSource.open(request.rowid).catch(() => null);
  if (!opened) return fail('not_found');
  try {
    const outcome = await lane.job(
      {
        type: 'render',
        reqId,
        input: opened.input,
        mode: request.mode,
        assetBase: `${ASSET_SCHEME}://${VIEW_HOST}/${request.token}`,
      },
      request.lane,
    );
    if (!outcome.ok) {
      return outcome.reason === 'superseded'
        ? fail('superseded')
        : fail('reader_failed', outcome.reason);
    }
    const message = outcome.message;
    if (message.type !== 'rendered') return fail('reader_failed', 'crash');
    if (!message.ok) return fail('reader_failed', 'parse');
    reply({ type: 'result', reqId, ok: true, read: message.message });
  } finally {
    await opened.close().catch(() => undefined);
  }
}

function startOpen(request: OpenRequest | ReadRequest): void {
  if (request.type === 'open') build(request);
  else void read(request);
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
  }
}

process.parentPort.once('message', (event) => {
  const init = event.data as CoreInit;
  roots = [[init.appRoot + sep, '']];
  log = new LogWriter(init.logsDir, 'core', 'core');
  workerLog = log.forProc('worker');
  const p = event.ports[0];
  if (!p) return;
  port = p;
  port.on('message', (message) => handle(message.data as CoreRequest));
  port.start();
  lane.start();
  port.postMessage({ type: 'ready' });
});
