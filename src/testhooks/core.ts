// SPDX-License-Identifier: AGPL-3.0-or-later
// Core-process test hooks: hold opens to keep them pending, and push markers
// through every logging path.

import type { CoreResult, OpenRequest, TestRequest, WorkerRequest } from '../shared/core-protocol';
import { errorData } from '../shared/log/schema';
import type { LogWriter } from '../shared/log/writer';
import { markLoaded } from './marker';

markLoaded();

export interface CoreTestDeps {
  log: LogWriter;
  roots: Array<[string, string]>;
  state: { holding: boolean; held: OpenRequest[] };
  open: (request: OpenRequest) => void;
  toWorker: (message: WorkerRequest) => void;
  reply: (result: CoreResult) => void;
}

export function handleCoreTest(request: TestRequest, deps: CoreTestDeps): void {
  const markers = request.markers ?? '';
  const ok = (value?: number) =>
    deps.reply({
      type: 'result',
      reqId: request.reqId,
      ok: true,
      ...(value === undefined ? {} : { value }),
    });
  switch (request.action) {
    case 'hold':
      deps.state.holding = true;
      ok();
      return;
    case 'release': {
      deps.state.holding = false;
      const held = deps.state.held.splice(0);
      for (const open of held) deps.open(open);
      ok(held.length);
      return;
    }
    case 'held':
      ok(deps.state.held.length);
      return;
    case 'log':
      deps.log.info('test.log', {
        subject: markers,
        path: markers,
        reason: markers,
        errorClass: markers,
      });
      ok();
      return;
    case 'error':
      deps.log.error('test.error', errorData(new Error(markers), deps.roots));
      ok();
      return;
    case 'throw':
      setTimeout(() => {
        throw new Error(markers);
      }, 0);
      ok();
      return;
    case 'reject':
      void Promise.reject(new Error(markers));
      ok();
      return;
    case 'worker-log':
    case 'worker-crash':
    case 'worker-reject':
      deps.toWorker({ type: 'test', action: request.action, markers });
      ok();
      return;
    case 'exit':
      ok();
      setTimeout(() => process.exit(3), 50);
      return;
    default:
      deps.reply({ type: 'result', reqId: request.reqId, ok: false, code: 'invalid' });
  }
}
