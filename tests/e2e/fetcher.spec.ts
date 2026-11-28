// SPDX-License-Identifier: AGPL-3.0-or-later
// The fetcher in the running app, driven through main's test hooks (consent
// comes later): it starts with an empty environment, so none of main's TLS,
// proxy, certificate or Node settings reach it; it connects only to the test
// entry; and no marker in a URL or host name reaches a log through any of
// its paths (success, refusal, redirect, timeout, crash).

import { once } from 'node:events';
import { createServer as createHttpServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SourceActionResult } from '../../src/shared/api';
import { solidPng } from '../../tools/gen-export/images.mjs';
import { writeExport } from '../exports';
import { dualServer } from '../dual-server';
import { MARKERS, findMarkers } from '../markers';
import { testDir } from '../paths';
import { makeCerts } from '../tls-certs';
import { expect, launch, test } from './app';

const PNG = solidPng(2, 2, [10, 20, 30]);

type Result = { ok: boolean; reason?: string; insecure?: boolean; format?: string };

/** One loopback port that speaks http and https, with routes by path prefix. */
async function serve(routes: Array<[string, RequestListener]>, tls: { cert: string; key: string }) {
  const seen: string[] = [];
  const handler: RequestListener = (req, res) => {
    seen.push(req.url ?? '');
    const route = routes.find(([prefix]) => (req.url ?? '').startsWith(prefix));
    if (route) route[1](req, res);
    else res.writeHead(404).end();
  };
  const server = await dualServer(handler, tls);
  return {
    port: server.port,
    seen,
    url: (path: string, scheme = 'http') => `${scheme}://127.0.0.1:${server.port}${path}`,
    close: () => server.close(),
  };
}

test('main’s TLS, proxy, certificate and Node settings never reach the fetcher', async () => {
  const certs = makeCerts();
  const caFile = join(testDir('fetcher-env-ca'), 'ca.pem');
  writeFileSync(caFile, certs.ca);
  let proxied = 0;
  const proxy = createHttpServer((_q, res) => {
    proxied += 1;
    res.writeHead(200).end(PNG);
  });
  proxy.on('connect', () => (proxied += 1));
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  const s = await serve(
    [
      ['/a.png', (_q, res) => res.writeHead(200).end(PNG)],
      // A header over 1 KiB: refused only if NODE_OPTIONS reached the fetcher.
      ['/big-header.png', (_q, res) => res.writeHead(200, { 'X-Pad': 'x'.repeat(4096) }).end(PNG)],
    ],
    certs.server,
  );
  const pev = await launch('fetcher-env', {
    env: {
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      NODE_EXTRA_CA_CERTS: caFile,
      HTTPS_PROXY: proxyUrl,
      HTTP_PROXY: proxyUrl,
      https_proxy: proxyUrl,
      http_proxy: proxyUrl,
      NODE_USE_ENV_PROXY: '1',
      NODE_OPTIONS: '--max-http-header-size=1024',
    },
  });
  try {
    await pev.main('fetcherAllow', '127.0.0.1', s.port);
    // Signed by a CA only main's environment names: still not trusted.
    const tls = await pev.main<Result>('fetcherFetch', 'v1', 'r1', s.url('/a.png', 'https'));
    expect(tls).toMatchObject({ ok: false, reason: 'tls' });
    const plain = await pev.main<Result>('fetcherFetch', 'v1', 'r2', s.url('/big-header.png'));
    expect(plain).toMatchObject({ ok: true, format: 'png', insecure: true });
    expect(proxied).toBe(0);
    const destinations =
      await pev.main<Array<{ address: string; port: number }>>('fetcherDestinations');
    expect(destinations.map((d) => `${d.address}:${d.port}`)).toEqual([
      `127.0.0.1:${s.port}`,
      `127.0.0.1:${s.port}`,
    ]);
  } finally {
    await pev.close();
    await s.close();
    await new Promise<void>((r) => proxy.close(() => r()));
  }
});

test('no marker in a URL or host name reaches a log through the fetcher', async ({ pev }) => {
  const certs = makeCerts();
  const [email, , , tracker, host, file] = MARKERS;
  const marked = `/${encodeURIComponent(file)}?u=${encodeURIComponent(tracker)}&e=${encodeURIComponent(email)}`;
  let held = 0;
  const s = await serve(
    [
      ['/ok/', (_q, res) => res.writeHead(200).end(PNG)],
      ['/missing/', (_q, res) => res.writeHead(404).end()],
      ['/redirect/', (_q, res) => res.writeHead(302, { Location: `/ok${marked}` }).end()],
      [
        '/elsewhere/',
        (_q, res) => res.writeHead(302, { Location: `http://${host}:8080${marked}` }).end(),
      ],
      ['/slow/', () => undefined],
      ['/hold/', () => (held += 1)],
    ],
    certs.server,
  );
  try {
    await pev.main('fetcherAllow', '127.0.0.1', s.port);
    const fetch = (ref: string, path: string) =>
      pev.main<Result>('fetcherFetch', 'v', ref, s.url(path));
    expect(await fetch('ok', `/ok${marked}`)).toMatchObject({ ok: true });
    expect(await fetch('missing', `/missing${marked}`)).toMatchObject({
      ok: false,
      reason: 'status',
    });
    expect(await fetch('redirect', `/redirect${marked}`)).toMatchObject({ ok: true });
    expect(await fetch('elsewhere', `/elsewhere${marked}`)).toMatchObject({
      ok: false,
      reason: 'port',
    });
    const userinfo = `http://${encodeURIComponent(email)}@127.0.0.1:${s.port}${marked}`;
    expect(await pev.main<Result>('fetcherFetch', 'v', 'user', userinfo)).toMatchObject({
      ok: false,
      reason: 'userinfo',
    });
    expect(await fetch('slow', `/slow${marked}`)).toMatchObject({ ok: false, reason: 'timeout' });

    // A crash with a request in flight.
    const pending = fetch('hold', `/hold${marked}`);
    await expect.poll(() => held).toBe(1);
    const pid = await pev.main<number>('fetcherPid');
    process.kill(pid, 'SIGKILL');
    expect(await pending).toMatchObject({ ok: false, reason: 'crashed' });

    // Each path logged.
    await expect.poll(() => pev.hasLog('fetcher.exit')).toBe(true);
    const fetched = pev.logs('main').filter((l) => l.code === 'fetcher.fetched');
    expect(fetched).toHaveLength(2);
    expect(fetched.every((l) => l.proc === 'fetcher')).toBe(true);
    for (const reason of ['status', 'port', 'userinfo', 'timeout']) {
      expect(pev.hasLog('fetcher.refused', { proc: 'fetcher', reason })).toBe(true);
    }
    // The logs folder still has its three files, and no marker is in any.
    const files = readdirSync(pev.logsDir())
      .filter((f) => f.endsWith('.jsonl'))
      .sort();
    expect(files).toEqual(['core.jsonl', 'main.jsonl', 'renderer.jsonl']);
    const text = files.map((f) => readFileSync(join(pev.logsDir(), f), 'utf8')).join('\n');
    expect(findMarkers(text)).toEqual([]);
  } finally {
    await s.close();
  }
});

test('unsandboxed control: spawned with the export open and its access released, the fetcher reads the export', async ({
  pev,
}) => {
  const root = testDir('fetcher-control');
  const written = writeExport(root, { seed: 3 });
  await pev.main('queuePick', root, 'bm1');
  expect(await pev.shell<SourceActionResult>('chooseFolder')).toMatchObject({
    ok: true,
    outcome: 'opened',
  });
  await pev.main('clearSourceOrder');
  const labels = join(written.run, 'labels.json');
  // Without the App Sandbox nothing stops the read: the folder proof shows the
  // sandboxed fetcher is denied the same read.
  expect(await pev.main('fetcherRead', labels)).toEqual({ ok: true, code: null });
  const order = await pev.main<Array<{ step: string }>>('sourceOrder');
  expect(order.map((s) => s.step)).toEqual(['scope.release', 'fetcher.spawn', 'scope.start']);
  const sources = await pev.main<{ active: { status: string } | null }>('sourcesView');
  expect(sources.active?.status).toBe('online');
});

test('a scope that can’t be started again after the spawn takes the export offline; the fetcher stays up', async ({
  pev,
}) => {
  const root = testDir('fetcher-restart');
  const written = writeExport(root, { seed: 4 });
  await pev.main('queuePick', root, 'bm1');
  expect(await pev.shell<SourceActionResult>('chooseFolder')).toMatchObject({
    ok: true,
    outcome: 'opened',
  });
  await pev.main('clearSourceOrder');
  // The bookmark fails from now on, as for an export that went away.
  await pev.main('failBookmark', 'bm1');
  expect(await pev.main('fetcherRead', join(written.run, 'labels.json'))).toEqual({
    ok: true,
    code: null,
  });
  const order = await pev.main<Array<{ step: string }>>('sourceOrder');
  expect(order.map((s) => s.step)).toEqual([
    'scope.release',
    'fetcher.spawn',
    'scope.failed',
    'core.stop',
    'core.spawn',
  ]);
  await expect
    .poll(
      async () =>
        (await pev.main<{ active: { status: string } | null }>('sourcesView')).active?.status,
    )
    .toBe('offline');
  expect(await pev.main<number | null>('fetcherPid')).not.toBeNull();
  expect(pev.hasLog('scope.failed')).toBe(true);
  expect(await pev.main<string[]>('liveScopes')).toEqual([]);
});
