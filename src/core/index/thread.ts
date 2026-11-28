// SPDX-License-Identifier: AGPL-3.0-or-later
// The index's worker threads in core. One script serves three roles, chosen at
// spawn: the writer (the only write connection), the query thread (a
// read-only connection) and an index pool thread (reads and parses files).

import { parentPort, workerData } from 'node:worker_threads';
import { codeOf, threadHandler } from './ops';
import type { ThreadRequest, ThreadRole } from './pool';

const handle = threadHandler((workerData as { role: ThreadRole }).role);

parentPort?.on('message', (r: ThreadRequest) => {
  // An operation that reads a stream answers with a promise.
  void (async () => {
    try {
      parentPort?.postMessage({ id: r.id, ok: true, data: await handle(r.op, r.args) });
    } catch (err) {
      parentPort?.postMessage({ id: r.id, ok: false, error: codeOf(err) });
    }
  })();
});
