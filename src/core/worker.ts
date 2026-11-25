// SPDX-License-Identifier: AGPL-3.0-or-later
// Reader worker. It builds message bodies; for now, the fixed placeholder bodies.

import { sep } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import type { WorkerMessage, WorkerRequest } from '../shared/core-protocol';
import { errorData } from '../shared/log/schema';
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

parentPort?.on('message', (request: WorkerRequest) => {
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
});
