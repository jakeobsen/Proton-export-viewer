// SPDX-License-Identifier: AGPL-3.0-or-later
// Reader worker. It builds message bodies: rendered messages, and the fixed
// placeholder bodies.

import { sep } from 'node:path';
import type { Readable } from 'node:stream';
import { getHeapStatistics } from 'node:v8';
import { parentPort, workerData } from 'node:worker_threads';
import type { WorkerMessage, WorkerRequest } from '../shared/core-protocol';
import { errorData } from '../shared/log/schema';
import type {
  ReaderInput,
  WorkerRender,
  WorkerRendered,
  WorkerSource,
  WorkerSourced,
} from '../shared/reader-protocol';
import { fdRead, fdReread } from './reader/fd-input';
import type { Reread } from './reader/images';
import { renderMessage } from './reader/render';
import { messageHeaderBlock, messageStructure, partHeaderBlock } from './reader/source-view';
import { STUBS, type StubBuilder } from './stubs';

const appRoot = (workerData as { appRoot?: string } | null)?.appRoot ?? '';
const roots: Array<[string, string]> = appRoot
  ? [[appRoot.endsWith(sep) ? appRoot : appRoot + sep, '']]
  : [];

function post(message: WorkerMessage): void {
  parentPort?.postMessage(message);
}

/** Posts a rendered body, handing over its images' memory rather than copying it. */
function postRendered(message: WorkerRendered): void {
  const images = message.ok ? message.message.images : [];
  parentPort?.postMessage(
    message,
    images.map((image) => image.bytes.buffer as ArrayBuffer),
  );
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
  // The file is core's: read it by position and leave it open for core to
  // close, even when the read fails and its stream is destroyed.
  if (input.kind === 'fd') return fdRead(input.fd);
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
    // Taken before the first read: the second read for inline images checks
    // the file against it.
    const reread: Reread =
      request.input.kind === 'fd'
        ? fdReread(request.input.fd)
        : { open: () => inputStream(request.input) };
    const input = await inputStream(request.input);
    if (!input) return failed();
    const sanitize =
      __PEV_TEST_HOOKS__ && request.unsanitized
        ? (await import('../testhooks/unsanitized')).unsanitized
        : undefined;
    const message = await renderMessage(input, {
      mode: request.mode,
      assetBase: request.assetBase,
      reread,
      onImagesRefused: (refused) => {
        for (const [reason, count] of refused) {
          post({
            type: 'log',
            level: 'info',
            code: 'reader.images_refused',
            data: { reason, count },
          });
        }
      },
      onPreviewUnchecked: (count) =>
        post({ type: 'log', level: 'info', code: 'reader.preview_unchecked', data: { count } }),
      ...(sanitize ? { sanitize } : {}),
      ...(request.stored ? { stored: request.stored } : {}),
      onMarksDropped: (count) => {
        post({ type: 'log', level: 'warn', code: 'reader.marks_dropped', data: { count } });
      },
    });
    return { type: 'rendered', reqId: request.reqId, heldBytes: heldBytes(), ok: true, message };
  } catch (err) {
    post({ type: 'log', level: 'warn', code: 'reader.parse_failed', data: errorData(err, roots) });
    return failed();
  }
}

/** Reads for the source view: a header block, or the message's parts. */
async function source(request: WorkerSource): Promise<WorkerSourced> {
  const failed = (): WorkerSourced => ({
    type: 'sourced',
    reqId: request.reqId,
    heldBytes: heldBytes(),
    ok: false,
  });
  try {
    const input = await inputStream(request.input);
    if (!input) return failed();
    const done = { type: 'sourced', reqId: request.reqId, ok: true } as const;
    const { what } = request;
    if (what.kind === 'structure') {
      const parts = await messageStructure(input);
      return { ...done, heldBytes: heldBytes(), parts };
    }
    const headers =
      what.kind === 'headers'
        ? await messageHeaderBlock(input)
        : await partHeaderBlock(input, what.path);
    return {
      ...done,
      heldBytes: heldBytes(),
      headers: headers && { bytes: new Uint8Array(headers.bytes), truncated: headers.truncated },
    };
  } catch (err) {
    post({ type: 'log', level: 'warn', code: 'reader.parse_failed', data: errorData(err, roots) });
    return failed();
  }
}

parentPort?.on('message', (request: WorkerRequest) => {
  if (request.type === 'render') {
    void render(request).then(postRendered);
    return;
  }
  if (request.type === 'source') {
    void source(request).then(post);
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
