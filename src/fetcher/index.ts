// SPDX-License-Identifier: AGPL-3.0-or-later
// The remote-image fetcher: a utility process that main starts when the user
// first allows a message's external images, and stops when no open view
// allows them any more. It is the only code in the app with network APIs.
//
// It gets view keys, references and URLs over a MessagePort and sends back
// checked image bytes or a refusal code. It writes no file and keeps nothing:
// its log events go to main, which checks them against the log schema again.
//
// Main starts it while the open export's folder access is released, so it
// holds no access to the export. What it can still read is what every helper
// of the app can: the app's own container (the index, which holds message
// text, and the logs) and the Downloads folder. So it parses as little as it
// can: Node's HTTP parser and the raster check, nothing else. It may not
// import file system or process modules (lint, and a check of the built
// bundle).

import { lookup } from 'node:dns';
import {
  type Destination,
  type FetcherInit,
  type FetcherLog,
  type FetchRequest,
  type FromFetcher,
  type ToFetcher,
} from '../shared/fetcher-protocol';
import { errorClassOf } from '../shared/log/schema';
import { fetchImage, type FetchEnv, type ImageOutcome } from './request';
import { ViewScheduler } from './views';

let port: Electron.MessagePortMain | null = null;

function post(message: FromFetcher): void {
  port?.postMessage(message);
}

function log(level: FetcherLog['level'], code: string, data?: Record<string, unknown>): void {
  post({ type: 'log', level, code, ...(data ? { data } : {}) });
}

process.on('uncaughtException', (err) =>
  log('error', 'fetcher.uncaught', { errorClass: errorClassOf(err) }),
);
process.on('unhandledRejection', (reason) =>
  log('error', 'fetcher.rejection', { errorClass: errorClassOf(reason) }),
);

function report(request: FetchRequest, outcome: ImageOutcome): void {
  const { viewKey, ref } = request;
  if (outcome.ok) {
    log('info', 'fetcher.fetched', {
      status: outcome.status,
      bytes: outcome.bytes.length,
      ms: Math.round(outcome.ms),
    });
    post({
      type: 'result',
      viewKey,
      ref,
      ok: true,
      bytes: outcome.bytes,
      format: outcome.format,
      insecure: outcome.insecure,
    });
    return;
  }
  log('info', 'fetcher.refused', {
    reason: outcome.reason,
    ms: Math.round(outcome.ms),
    ...(outcome.status === null ? {} : { status: outcome.status }),
  });
  post({
    type: 'result',
    viewKey,
    ref,
    ok: false,
    reason: outcome.reason,
    insecure: outcome.insecure,
  });
}

function isString(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

function start(init: FetcherInit, mainPort: Electron.MessagePortMain): void {
  port = mainPort;
  const destinations: Destination[] = [];
  const env: FetchEnv = {
    resolve: lookup,
    allow: null,
    record: null,
    now: () => performance.now(),
  };
  if (__PEV_TEST_HOOKS__ && init.test) {
    env.allow = { ...init.test.loopbackAllow };
    if (init.test.recordConnects) env.record = (d) => destinations.push({ ...d });
  }
  const scheduler = new ViewScheduler(
    (url, view, signal) => fetchImage(url, view, signal, env),
    report,
  );

  mainPort.on('message', (event) => {
    const message = event.data as ToFetcher;
    if (typeof message !== 'object' || message === null) return;
    if (message.type === 'fetch') {
      if (
        !isString(message.viewKey, 64) ||
        !isString(message.ref, 16) ||
        !isString(message.url, 8192)
      ) {
        return;
      }
      scheduler.fetch({
        type: 'fetch',
        viewKey: message.viewKey,
        ref: message.ref,
        url: message.url,
      });
      return;
    }
    if (message.type === 'abort') {
      if (isString(message.viewKey, 64)) scheduler.abort(message.viewKey);
      return;
    }
    if (__PEV_TEST_HOOKS__) {
      if (message.type === 'test') void testCall(message, destinations);
    }
  });
  mainPort.start();
  post({ type: 'ready' });
}

/** Builds with test hooks only: the destination record, or a read the sandboxed self-test asks for. */
async function testCall(
  message: Extract<ToFetcher, { type: 'test' }>,
  destinations: Destination[],
): Promise<void> {
  if (__PEV_TEST_HOOKS__) {
    if (message.call === 'destinations') {
      post({
        type: 'test-reply',
        reqId: message.reqId,
        destinations: destinations.map((d) => ({ ...d })),
      });
    } else {
      const hooks = await import('../testhooks/fetcher');
      post({ type: 'test-reply', reqId: message.reqId, read: hooks.tryRead(message.path) });
    }
  }
}

process.parentPort.once('message', (event) => {
  const [mainPort] = event.ports;
  if (!mainPort) return;
  start(event.data as FetcherInit, mainPort);
});
