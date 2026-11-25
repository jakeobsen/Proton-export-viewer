// SPDX-License-Identifier: AGPL-3.0-or-later
// Reader-worker test hooks: crash the worker with markers in the error.

import { parentPort } from 'node:worker_threads';
import type { WorkerTest } from '../shared/core-protocol';
import { markLoaded } from './marker';

markLoaded();

export function handleWorkerTest(request: WorkerTest): void {
  const markers = request.markers ?? '';
  switch (request.action) {
    case 'worker-log':
      parentPort?.postMessage({
        type: 'log',
        level: 'info',
        code: 'test.log',
        data: { subject: markers, path: markers, reason: markers },
      });
      return;
    case 'worker-crash':
      setTimeout(() => {
        throw new Error(markers);
      }, 0);
      return;
    case 'worker-reject':
      void Promise.reject(new Error(markers));
      return;
  }
}
