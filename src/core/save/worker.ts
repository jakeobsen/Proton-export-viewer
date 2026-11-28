// SPDX-License-Identifier: AGPL-3.0-or-later
// Save worker: one per save. It reads the message through core's descriptor,
// which core closes once this thread has exited, and hands its chunks to core
// one at a time: the next is made only when core says the last was taken.

import { Readable } from 'node:stream';
import { parentPort } from 'node:worker_threads';
import type { SaveTarget, SaveWorkerIn, SaveWorkerOut } from '../../shared/save-protocol';
import { borrowedFdStream } from '../fd-stream';
import { SaveStop, produceFile, producePart, type ChunkSink } from './produce';

function post(message: SaveWorkerOut): void {
  if (message.type === 'chunk' || message.type === 'last') {
    parentPort?.postMessage(message, [message.bytes.buffer as ArrayBuffer]);
  } else {
    parentPort?.postMessage(message);
  }
}

function crash(code: 'worker.uncaught' | 'worker.rejection'): void {
  post({ type: 'log', level: 'error', code });
  setImmediate(() => process.exit(70));
}

process.on('uncaughtException', () => crash('worker.uncaught'));
process.on('unhandledRejection', () => crash('worker.rejection'));

let more: (() => void) | null = null;

const sink: ChunkSink = {
  put: (bytes) =>
    new Promise<void>((resolve) => {
      more = resolve;
      post({ type: 'chunk', bytes });
    }),
  tick: () => post({ type: 'tick' }),
};

/** The message's first `size` bytes, read by position; nothing for an empty file. */
function input(fd: number, size: number): Readable {
  return size > 0 ? borrowedFdStream(fd, { start: 0, end: size - 1 }) : Readable.from([]);
}

async function run(fd: number, target: SaveTarget, fileSize: number): Promise<void> {
  try {
    const last =
      target.kind === 'eml'
        ? await produceFile(target.size > 0 ? input(fd, target.size) : null, target, sink)
        : await producePart(input(fd, fileSize), target, sink);
    post({ type: 'last', bytes: last });
  } catch (err) {
    post({ type: 'failed', reason: err instanceof SaveStop ? err.reason : 'unreadable' });
  }
}

parentPort?.on('message', (message: SaveWorkerIn) => {
  if (message.type === 'more') {
    const resume = more;
    more = null;
    resume?.();
    return;
  }
  if (message.type === 'start') void run(message.fd, message.target, message.fileSize);
});
