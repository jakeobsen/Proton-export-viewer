// SPDX-License-Identifier: AGPL-3.0-or-later
// Reader worker. It builds message bodies: rendered messages, and the fixed
// placeholder bodies.

import { createReadStream } from 'node:fs';
import { sep } from 'node:path';
import type { Readable } from 'node:stream';
import { getHeapStatistics } from 'node:v8';
import { parentPort, workerData } from 'node:worker_threads';
import type { WorkerMessage, WorkerRequest } from '../shared/core-protocol';
import { errorData } from '../shared/log/schema';
import type { ReaderInput, WorkerRender, WorkerRendered } from '../shared/reader-protocol';
import { renderMessage } from './reader/render';
import { STUBS, type StubBuilder } from './stubs';

const appRoot = (workerData as { appRoot?: string } | null)?.appRoot ?? '';
const roots: Array<[string, string]> = appRoot
  ? [[appRoot.endsWith(sep) ? appRoot : appRoot + sep, '']]
  : [];

function post(message: WorkerMessage): void {
  parentPort?.postMessage(message);
}

function crash(code: 'worker.uncaught' | 'worker.rejection', err: unknown): void {
  post({ type: 'log', level: 'error', code, data: errorData(err, roots) });
  // Let the log message leave before the thread ends; core logs the exit.
  setImmediate(() => process.exit(70));
}

process.on('uncaughtException', (err) => crash('worker.uncaught', err));
process.on('unhandledRejection', (reason) => crash('worker.rejection', reason));

async function builderFor(stubId: string): Promise<StubBuilder | undefined> {
  const own = Object.prototype.hasOwnProperty.call(STUBS, stubId) ? STUBS[stubId] : undefined;
  if (own || !__PEV_TEST_HOOKS__) return own;
  const { TEST_STUBS } = await import('../testhooks/stubs');
  return Object.prototype.hasOwnProperty.call(TEST_STUBS, stubId) ? TEST_STUBS[stubId] : undefined;
}

async function inputStream(input: ReaderInput): Promise<Readable | null> {
  // The file is core's: read it by position and leave it open for core to close.
  if (input.kind === 'fd')
    return createReadStream('', { fd: input.fd, autoClose: false, start: 0 });
  if (__PEV_TEST_HOOKS__ && input.kind === 'test') {
    const hooks = await import('../testhooks/reader-input');
    return hooks.testStream(input.input);
  }
  return null;
}

/** The memory this worker holds now: its JS heap, and the buffers outside it. */
function heldBytes(): number {
  const heap = getHeapStatistics();
  return heap.total_heap_size + heap.external_memory;
}

async function render(request: WorkerRender): Promise<WorkerRendered> {
  const failed = (): WorkerRendered => ({
    type: 'rendered',
    reqId: request.reqId,
    heldBytes: heldBytes(),
    ok: false,
    code: 'parse',
  });
  try {
    const input = await inputStream(request.input);
    if (!input) return failed();
    const message = await renderMessage(input, {
      mode: request.mode,
      assetBase: request.assetBase,
    });
    return { type: 'rendered', reqId: request.reqId, heldBytes: heldBytes(), ok: true, message };
  } catch (err) {
    post({ type: 'log', level: 'warn', code: 'reader.parse_failed', data: errorData(err, roots) });
    return failed();
  }
}

parentPort?.on('message', (request: WorkerRequest) => {
  if (request.type === 'render') {
    void render(request).then(post);
    return;
  }
  if (request.type === 'build') {
    void builderFor(request.stubId).then((builder) => {
      if (!builder) {
        post({ type: 'result', reqId: request.reqId, ok: false, code: 'unknown_stub' });
        return;
      }
      const body = builder(`mail-asset://v/${request.token}`);
      post({ type: 'result', reqId: request.reqId, ok: true, body });
    });
    return;
  }
  if (__PEV_TEST_HOOKS__ && request.type === 'test') {
    void import('../testhooks/worker').then((hooks) => hooks.handleWorkerTest(request));
  }
  if (__PEV_TEST_HOOKS__ && request.type === 'proof-read') {
    void import('../testhooks/proof/worker').then((hooks) => post(hooks.handleProofRead(request)));
  }
});
