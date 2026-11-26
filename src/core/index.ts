// SPDX-License-Identifier: AGPL-3.0-or-later
// Core utility process. It owns the reader worker and answers main over a MessagePort.

import { join, sep } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { MessagePortMain } from 'electron';
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

process.umask(0o077);

let log: LogWriter | null = null;
let workerLog: Logger | null = null;
let roots: Array<[string, string]> = [];
let port: MessagePortMain | null = null;
let worker: Worker | null = null;
const waiting = new Map<number, (message: WorkerMessage) => void>();

/** Test builds can hold opens in core to keep them pending. */
const testState = { holding: false, held: [] as OpenRequest[] };

process.on('uncaughtException', (err) => log?.error('core.uncaught', errorData(err, roots)));
process.on('unhandledRejection', (reason) =>
  log?.error('core.rejection', errorData(reason, roots)),
);

function reply(result: CoreResult): void {
  port?.postMessage(result);
}

function spawnWorker(): Worker {
  const w = new Worker(join(import.meta.dirname, 'core-worker.js'), {
    workerData: { appRoot: roots[0]?.[0] ?? '' },
  });
  log?.info('core.worker_spawn');
  w.on('message', (message: WorkerMessage) => {
    if (message.type === 'log') {
      workerLog?.log(message.level, message.code, message.data);
      return;
    }
    const done = waiting.get(message.reqId);
    if (done) {
      waiting.delete(message.reqId);
      done(message);
    }
  });
  w.on('error', (err) => log?.error('core.worker_error', errorData(err, roots)));
  w.on('exit', (code) => {
    log?.warn('core.worker_exit', { exitCode: code });
    if (worker === w) worker = null;
    for (const [reqId, done] of waiting) {
      done({ type: 'result', reqId, ok: false, code: 'unknown_stub' });
    }
    waiting.clear();
  });
  return w;
}

function toWorker(message: WorkerRequest): void {
  worker ??= spawnWorker();
  worker.postMessage(message);
}

/** Folder-access proof (test builds): has the worker read files, as request `reqId`. */
function workerRead(reqId: number, paths: string[]): Promise<ProofFileRead[] | null> {
  return new Promise((resolve) => {
    waiting.set(reqId, (message) => resolve(message.type === 'proof-read' ? message.reads : null));
    toWorker({ type: 'proof-read', reqId, paths });
  });
}

function open(request: OpenRequest): void {
  waiting.set(request.reqId, (message) => {
    if (message.type !== 'result') return;
    if (message.ok) {
      reply({ type: 'result', reqId: request.reqId, ok: true, body: message.body });
    } else {
      reply({ type: 'result', reqId: request.reqId, ok: false, code: 'unknown_stub' });
    }
  });
  toWorker({ type: 'build', reqId: request.reqId, stubId: request.stubId, token: request.token });
}

function handle(request: CoreRequest): void {
  switch (request.type) {
    case 'open':
      if (__PEV_TEST_HOOKS__ && testState.holding) {
        testState.held.push(request);
        return;
      }
      open(request);
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
            open,
            toWorker,
            reply,
            dir: import.meta.dirname,
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
  worker = spawnWorker();
  port.postMessage({ type: 'ready' });
});
