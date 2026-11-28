// SPDX-License-Identifier: AGPL-3.0-or-later
// The fetcher's requests, against loopback servers reached only through the
// test-hook entry: exactly five headers; only checked addresses connected to;
// 2xx, identity encoding and the raster check; at most five redirects, each
// checked again; https to http marked insecure; any certificate error refused;
// the byte and time budgets at their limits and one past; abort at once.
//
// node:http and node:https pass through a recorder, so the tests see the exact
// options each request was made with. The https one also trusts the test CA,
// which a production request never gets.

import { once } from 'node:events';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  IMAGE_MAX_BYTES,
  VIEW_MAX_BYTES,
  type Destination,
  type FetchRequest,
} from '../../src/shared/fetcher-protocol';
import { paddedPng, solidPng } from '../../tools/gen-export/images.mjs';
import { dualServer } from '../dual-server';
import { makeCerts, type TestCerts } from '../tls-certs';

const hooks = vi.hoisted(() => ({
  ca: null as string | null,
  rewrite: null as null | ((o: Record<string, unknown>) => Record<string, unknown>),
  options: [] as Array<Record<string, unknown>>,
}));

vi.mock('node:http', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:http')>();
  return {
    ...real,
    request: (o: Record<string, unknown>) => {
      hooks.options.push({ ...o, scheme: 'http' });
      return real.request((hooks.rewrite?.(o) ?? o) as never);
    },
  };
});

vi.mock('node:https', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:https')>();
  return {
    ...real,
    request: (o: Record<string, unknown>) => {
      hooks.options.push({ ...o, scheme: 'https' });
      return real.request({
        ...(hooks.rewrite?.(o) ?? o),
        ...(hooks.ca ? { ca: hooks.ca } : {}),
      } as never);
    },
  };
});

const { fetchImage, policyLookup, ACCEPT, USER_AGENT } = await import('../../src/fetcher/request');
const { ViewScheduler } = await import('../../src/fetcher/views');
type FetchEnv = import('../../src/fetcher/request').FetchEnv;
type ViewBytes = import('../../src/fetcher/request').ViewBytes;
type ImageOutcome = import('../../src/fetcher/request').ImageOutcome;

const PNG = solidPng(2, 2, [10, 20, 30]);

let certs: TestCerts;
beforeAll(() => {
  certs = makeCerts();
});

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  hooks.ca = null;
  hooks.rewrite = null;
  hooks.options.length = 0;
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  delete process.env.HTTPS_PROXY;
  delete process.env.HTTP_PROXY;
  delete process.env.https_proxy;
  delete process.env.http_proxy;
  for (const close of closers.splice(0)) await close();
});

interface Seen {
  scheme: 'http' | 'https';
  method: string;
  url: string;
  version: string;
  rawHeaders: string[];
}

type Route = (req: IncomingMessage, res: ServerResponse) => void;

/** One loopback port that speaks both http and https (by the first byte), with routes by path. */
async function serve(routes: Record<string, Route>, tls = () => certs.server) {
  const seen: Seen[] = [];
  const handler: RequestListener = (req, res) => {
    const scheme = (req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http';
    seen.push({
      scheme,
      method: req.method ?? '',
      url: req.url ?? '',
      version: req.httpVersion,
      rawHeaders: [...req.rawHeaders],
    });
    const route = routes[(req.url ?? '').split('?')[0]!];
    if (route) route(req, res);
    else res.writeHead(404).end();
  };
  const server = await dualServer(handler, tls());
  closers.push(() => server.close());
  const { port } = server;
  return {
    port,
    seen,
    connections: () => server.connections(),
    url: (path: string, scheme = 'http', host = '127.0.0.1') =>
      `${scheme}://${host}:${port}${path}`,
  };
}

const png: Route = (_req, res) => res.writeHead(200, { 'Content-Type': 'image/png' }).end(PNG);
const never: Route = () => undefined;

function envFor(port: number, extra: Partial<FetchEnv> = {}) {
  const destinations: Destination[] = [];
  const env: FetchEnv = {
    resolve: (_h, _o, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]),
    allow: { address: '127.0.0.1', port },
    record: (d) => destinations.push(d),
    now: () => performance.now(),
    ...extra,
  };
  return { env, destinations };
}

const unlimited: ViewBytes = { take: () => true, left: () => Number.MAX_SAFE_INTEGER };
const get = (url: string, env: FetchEnv, view = unlimited, signal = new AbortController().signal) =>
  fetchImage(url, view, signal, env);
const reason = (o: ImageOutcome) => (o.ok ? 'ok' : o.reason);

describe('the request', () => {
  it('sends exactly five headers, GET over HTTP/1.1, with the path and query only', async () => {
    const s = await serve({ '/a.png': png });
    const { env } = envFor(s.port);
    const out = await get(s.url('/a.png?x=1#frag'), env);
    expect(reason(out)).toBe('ok');
    expect(s.seen).toEqual([
      {
        scheme: 'http',
        method: 'GET',
        url: '/a.png?x=1',
        version: '1.1',
        rawHeaders: [
          'Host',
          `127.0.0.1:${s.port}`,
          'User-Agent',
          USER_AGENT,
          'Accept',
          ACCEPT,
          'Accept-Encoding',
          'identity',
          'Connection',
          'close',
        ],
      },
    ]);
    expect(ACCEPT).toBe('image/png,image/jpeg,image/gif,image/webp');
  });

  it('passes a fresh agent, no proxy and no socket overrides', async () => {
    const s = await serve({ '/a.png': png });
    hooks.ca = certs.ca;
    const { env } = envFor(s.port);
    expect(reason(await get(s.url('/a.png', 'https', 'localhost'), env))).toBe('ok');
    expect(reason(await get(s.url('/a.png', 'https'), env))).toBe('ok');
    const [named, literal] = hooks.options;
    for (const o of [named!, literal!]) {
      expect(o.agent).toBe(false);
      expect(o.autoSelectFamily).toBe(false);
      expect(o.insecureHTTPParser).toBe(false);
      expect(o.rejectUnauthorized).toBe(true);
      expect(o.setHost).toBe(false);
      for (const key of [
        'socketPath',
        'createConnection',
        'localAddress',
        'ca',
        'proxy',
        'family',
        'hints',
      ]) {
        expect(o).not.toHaveProperty(key);
      }
    }
    // SNI is the host name; none for an IP literal.
    expect(named!.servername).toBe('localhost');
    expect(literal!.servername).toBe('');
  });

  it('records each connect: the checked address, the port and the TLS server name', async () => {
    const s = await serve({ '/a.png': png });
    hooks.ca = certs.ca;
    const { env, destinations } = envFor(s.port);
    await get(s.url('/a.png'), env);
    await get(s.url('/a.png', 'https', 'localhost'), env);
    expect(destinations).toEqual([
      { address: '127.0.0.1', port: s.port, servername: null },
      { address: '127.0.0.1', port: s.port, servername: 'localhost' },
    ]);
  });

  it('a socket that connects anywhere but a checked address is refused', async () => {
    const other = createHttpServer(png);
    other.listen(0, '::1');
    await once(other, 'listening');
    closers.push(() => new Promise((r) => other.close(() => r())));
    const s = await serve({ '/a.png': png });
    // As if the connect went somewhere the policy never checked.
    hooks.rewrite = (o) => ({ ...o, host: '::1', port: (other.address() as AddressInfo).port });
    const { env, destinations } = envFor(s.port);
    expect(reason(await get(s.url('/a.png'), env))).toBe('address');
    expect(destinations).toEqual([]);
  });
});

describe('the policy lookup', () => {
  const answers =
    (list: Array<[string, number]>) =>
    (_h: string, _o: unknown, cb: (e: null, a: unknown) => void) =>
      cb(
        null,
        list.map(([address, family]) => ({ address, family })),
      );
  const run = (
    resolve: unknown,
    options: Record<string, unknown>,
    target = { port: 443, testPort: false },
  ) =>
    new Promise<{ err: unknown; address: unknown; family: unknown; checked: string[] }>((done) => {
      const checked: import('../../src/fetcher/address').Ip[] = [];
      policyLookup(
        resolve as never,
        target,
        null,
        checked,
        () => false,
      )('h.example', options as never, (err, address, family) =>
        done({ err, address, family, checked: checked.map((c) => String(c.value)) }),
      );
    });

  it('gives every checked address when asked for all, and one otherwise', async () => {
    const resolve = answers([
      ['8.8.8.8', 4],
      ['2606:4700::1111', 6],
    ]);
    const all = await run(resolve, { all: true });
    expect(all.err).toBeNull();
    expect(all.address).toEqual([
      { address: '8.8.8.8', family: 4 },
      { address: '2606:4700::1111', family: 6 },
    ]);
    const one = await run(resolve, {});
    expect([one.err, one.address, one.family]).toEqual([null, '8.8.8.8', 4]);
    const six = await run(resolve, { family: 6 });
    expect([six.err, six.address, six.family]).toEqual([null, '2606:4700::1111', 6]);
    const sixAll = await run(resolve, { family: 6, all: true });
    expect(sixAll.address).toEqual([{ address: '2606:4700::1111', family: 6 }]);
  });

  it('refuses the name if any answer is refused, in both forms', async () => {
    const resolve = answers([
      ['8.8.8.8', 4],
      ['10.0.0.1', 4],
    ]);
    for (const options of [{ all: true }, {}]) {
      const r = await run(resolve, options);
      expect((r.err as { reason?: string }).reason).toBe('address');
      expect(r.checked).toEqual([]);
    }
  });

  it('a failed resolution is a DNS refusal; a family with no answer too', async () => {
    const failing = (_h: string, _o: unknown, cb: (e: Error, a: unknown[]) => void) =>
      cb(new Error('ENOTFOUND'), []);
    expect(((await run(failing, { all: true })).err as { reason?: string }).reason).toBe('dns');
    const v4only = answers([['8.8.8.8', 4]]);
    expect(((await run(v4only, { family: 6 })).err as { reason?: string }).reason).toBe('dns');
  });

  it('on the test port, only the test address', async () => {
    const resolve = answers([['8.8.8.8', 4]]);
    const r = await run(resolve, { all: true }, { port: 41234, testPort: true });
    expect((r.err as { reason?: string }).reason).toBe('port');
  });
});

describe('names and addresses', () => {
  it('a name resolved to the test address is fetched; one with a refused answer never connects', async () => {
    const s = await serve({ '/a.png': png });
    const { env } = envFor(s.port);
    expect(reason(await get(s.url('/a.png', 'http', 'img.test'), env))).toBe('ok');
    const mixed = envFor(s.port, {
      resolve: (_h, _o, cb) =>
        cb(null, [
          { address: '127.0.0.1', family: 4 },
          { address: '10.0.0.1', family: 4 },
        ]),
    });
    expect(reason(await get(s.url('/b.png', 'http', 'img.test'), mixed.env))).toBe('address');
    expect(s.seen.map((x) => x.url)).toEqual(['/a.png']);
    expect(s.connections()).toBe(1);
  });

  it('a name on the test port that resolves elsewhere is refused before any connect', async () => {
    const s = await serve({ '/a.png': png });
    const { env, destinations } = envFor(s.port, {
      resolve: (_h, _o, cb) => cb(null, [{ address: '8.8.8.8', family: 4 }]),
    });
    expect(reason(await get(s.url('/a.png', 'http', 'img.test'), env))).toBe('port');
    expect(destinations).toEqual([]);
  });

  it('without the test entry, loopback is refused as an address', async () => {
    const s = await serve({ '/a.png': png });
    const { env } = envFor(s.port, { allow: null });
    expect(reason(await get(s.url('/a.png'), env))).toBe('port');
    expect(reason(await get('http://127.0.0.1/a.png', env))).toBe('address');
    expect(reason(await get('http://[::1]/a.png', env))).toBe('address');
    expect(reason(await get('http://[::ffff:127.0.0.1]/a.png', env))).toBe('address');
    expect(reason(await get('http://0x7f000001/a.png', env))).toBe('address');
    expect(reason(await get('http://localhost/a.png', envFor(s.port, { allow: null }).env))).toBe(
      'address',
    );
    expect(s.connections()).toBe(0);
  });
});

describe('the response', () => {
  it('takes a 2xx image only', async () => {
    const s = await serve({
      '/ok': png,
      '/404': (_q, res) => res.writeHead(404).end(PNG),
      '/500': (_q, res) => res.writeHead(500).end(PNG),
      '/304': (_q, res) => res.writeHead(304).end(),
      '/302-no-location': (_q, res) => res.writeHead(302).end(),
      '/204': (_q, res) => res.writeHead(204).end(),
      '/html': (_q, res) =>
        res.writeHead(200, { 'Content-Type': 'image/png' }).end('<html></html>'),
    });
    const { env } = envFor(s.port);
    const out = await get(s.url('/ok'), env);
    expect(out).toMatchObject({ ok: true, format: 'png', insecure: true, status: 200 });
    expect(out.ok && Buffer.from(out.bytes).equals(PNG)).toBe(true);
    expect(reason(await get(s.url('/404'), env))).toBe('status');
    expect(reason(await get(s.url('/500'), env))).toBe('status');
    expect(reason(await get(s.url('/304'), env))).toBe('status');
    expect(reason(await get(s.url('/302-no-location'), env))).toBe('status');
    expect(reason(await get(s.url('/204'), env))).toBe('format');
    expect(reason(await get(s.url('/html'), env))).toBe('format');
  });

  it('refuses any Content-Encoding but identity; nothing is decompressed', async () => {
    const encoded =
      (value: string): Route =>
      (_q, res) =>
        res.writeHead(200, { 'Content-Encoding': value }).end(PNG);
    const s = await serve({
      '/gzip': encoded('gzip'),
      '/br': encoded('br'),
      '/both': encoded('identity, gzip'),
      '/identity': encoded('identity'),
      '/IDENTITY': encoded(' Identity '),
    });
    const { env } = envFor(s.port);
    expect(reason(await get(s.url('/gzip'), env))).toBe('encoding');
    expect(reason(await get(s.url('/br'), env))).toBe('encoding');
    expect(reason(await get(s.url('/both'), env))).toBe('encoding');
    expect(reason(await get(s.url('/identity'), env))).toBe('ok');
    expect(reason(await get(s.url('/IDENTITY'), env))).toBe('ok');
  });

  it('refuses a raster bomb with its code', async () => {
    const big = Buffer.from(PNG);
    big.writeUInt32BE(100_000, 16); // width past the side limit
    const s = await serve({ '/bomb': (_q, res) => res.writeHead(200).end(big) });
    const { env } = envFor(s.port);
    expect(reason(await get(s.url('/bomb'), env))).toBe('canvas');
  });
});

describe('redirects', () => {
  const chain = (n: number): Record<string, Route> => {
    const routes: Record<string, Route> = { '/r0': png };
    for (let i = 1; i <= n; i += 1) {
      routes[`/r${i}`] = (_q, res) =>
        res.writeHead([301, 302, 303, 307, 308][i % 5]!, { Location: `r${i - 1}` }).end();
    }
    return routes;
  };

  it('follows five and refuses a sixth', async () => {
    const s = await serve(chain(6));
    const { env } = envFor(s.port);
    expect(reason(await get(s.url('/r5'), env))).toBe('ok');
    expect(s.seen.map((x) => x.url)).toEqual(['/r5', '/r4', '/r3', '/r2', '/r1', '/r0']);
    s.seen.length = 0;
    expect(reason(await get(s.url('/r6'), env))).toBe('redirects');
    expect(s.seen.map((x) => x.url)).toEqual(['/r6', '/r5', '/r4', '/r3', '/r2', '/r1']);
  });

  it('checks every hop again: address, port, scheme, user info and name', async () => {
    const to =
      (location: string): Route =>
      (_q, res) =>
        res.writeHead(302, { Location: location }).end();
    const s = await serve({
      '/private': to('http://10.0.0.1/x.png'),
      '/port': to('http://127.0.0.1:1/x.png'),
      '/scheme': to('file:///etc/hosts'),
      '/user': to('http://u:p@example.com/x.png'),
      '/name': to('http://rebind.test/x.png'),
    });
    const { env, destinations } = envFor(s.port, {
      resolve: (host, _o, cb) =>
        cb(null, [{ address: host === 'rebind.test' ? '192.168.1.1' : '127.0.0.1', family: 4 }]),
    });
    expect(reason(await get(s.url('/private'), env))).toBe('address');
    expect(reason(await get(s.url('/port'), env))).toBe('port');
    expect(reason(await get(s.url('/scheme'), env))).toBe('scheme');
    expect(reason(await get(s.url('/user'), env))).toBe('userinfo');
    expect(reason(await get(s.url('/name'), env))).toBe('address');
    // Only the first hops reached a server: the test entry's.
    expect(new Set(destinations.map((d) => `${d.address}:${d.port}`))).toEqual(
      new Set([`127.0.0.1:${s.port}`]),
    );
  });

  it('https to http is followed and marks the image insecure; https only is secure', async () => {
    hooks.ca = certs.ca;
    const s = await serve({
      '/down': (_q, res) =>
        res.writeHead(302, { Location: `http://localhost:${s.port}/a.png` }).end(),
      '/a.png': png,
    });
    const { env } = envFor(s.port);
    const secure = await get(s.url('/a.png', 'https', 'localhost'), env);
    expect(secure).toMatchObject({ ok: true, insecure: false });
    const down = await get(s.url('/down', 'https', 'localhost'), env);
    expect(down).toMatchObject({ ok: true, insecure: true });
    expect(s.seen.map((x) => `${x.scheme} ${x.url}`)).toEqual([
      'https /a.png',
      'https /down',
      'http /a.png',
    ]);
  });
});

describe('TLS', () => {
  it('refuses a self-signed certificate and one for another name', async () => {
    hooks.ca = certs.ca;
    const self = await serve({ '/a.png': png }, () => certs.selfSigned);
    expect(reason(await get(self.url('/a.png', 'https', 'localhost'), envFor(self.port).env))).toBe(
      'tls',
    );
    const wrong = await serve({ '/a.png': png }, () => certs.wrongName);
    expect(
      reason(await get(wrong.url('/a.png', 'https', 'localhost'), envFor(wrong.port).env)),
    ).toBe('tls');
    expect(self.seen).toEqual([]);
    expect(wrong.seen).toEqual([]);
  });

  it('ignores the environment: no TLS override and no proxy', async () => {
    let proxied = 0;
    const proxy = createHttpServer((_q, res) => {
      proxied += 1;
      res.writeHead(200).end(PNG);
    });
    proxy.on('connect', () => (proxied += 1));
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    closers.push(() => new Promise((r) => proxy.close(() => r())));
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    process.env.HTTPS_PROXY = proxyUrl;
    process.env.HTTP_PROXY = proxyUrl;
    process.env.https_proxy = proxyUrl;
    process.env.http_proxy = proxyUrl;
    const self = await serve({ '/a.png': png }, () => certs.selfSigned);
    const { env, destinations } = envFor(self.port);
    expect(reason(await get(self.url('/a.png', 'https', 'localhost'), env))).toBe('tls');
    expect(reason(await get(self.url('/a.png'), env))).toBe('ok');
    expect(proxied).toBe(0);
    expect(destinations.map((d) => d.port)).toEqual([self.port, self.port]);
  });
});

describe('budgets', () => {
  it('takes an image of exactly IMAGE_MAX_BYTES and refuses one byte more, declared or not', async () => {
    const exact = paddedPng(IMAGE_MAX_BYTES);
    const over = paddedPng(IMAGE_MAX_BYTES + 1);
    expect([exact.length, over.length]).toEqual([IMAGE_MAX_BYTES, IMAGE_MAX_BYTES + 1]);
    const chunked =
      (bytes: Buffer): Route =>
      (_q, res) => {
        res.writeHead(200);
        res.write(bytes.subarray(0, 1000));
        res.end(bytes.subarray(1000));
      };
    const s = await serve({
      '/exact': (_q, res) => res.writeHead(200, { 'Content-Length': exact.length }).end(exact),
      '/over': (_q, res) => res.writeHead(200, { 'Content-Length': over.length }).end(over),
      '/exact-chunked': chunked(exact),
      '/over-chunked': chunked(over),
    });
    const { env } = envFor(s.port);
    expect(reason(await get(s.url('/exact'), env))).toBe('ok');
    expect(reason(await get(s.url('/over'), env))).toBe('too_large');
    expect(reason(await get(s.url('/exact-chunked'), env))).toBe('ok');
    expect(reason(await get(s.url('/over-chunked'), env))).toBe('too_large');
  });

  it('refuses a declared length past the budget before any of the body arrives', async () => {
    const s = await serve({
      '/huge': (_q, res) => {
        res.writeHead(200, { 'Content-Length': IMAGE_MAX_BYTES + 1 });
        res.flushHeaders();
        // The body never comes.
      },
    });
    const { env } = envFor(s.port, { imageMaxMs: 5_000 });
    const started = performance.now();
    expect(reason(await get(s.url('/huge'), env))).toBe('too_large');
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('counts the image budget across redirects', async () => {
    const s = await serve({
      '/hop': (_q, res) => res.writeHead(302, { Location: '/exact' }).end(),
      '/exact': (_q, res) => res.writeHead(200).end(paddedPng(IMAGE_MAX_BYTES)),
    });
    const { env } = envFor(s.port);
    expect(reason(await get(s.url('/hop'), env))).toBe('ok');
  });

  it('a view takes exactly VIEW_MAX_BYTES, then refuses the next byte', async () => {
    const five = paddedPng(IMAGE_MAX_BYTES);
    const s = await serve({
      '/five': (_q, res) => {
        res.writeHead(200);
        res.end(five);
      },
      '/small': png,
    });
    expect(VIEW_MAX_BYTES).toBe(5 * IMAGE_MAX_BYTES);
    const { env } = envFor(s.port);
    const outcomes: Array<[string, string]> = [];
    let done!: () => void;
    const all = new Promise<void>((r) => (done = r));
    const scheduler = new ViewScheduler(
      (url, view, signal) => fetchImage(url, view, signal, env),
      (request, outcome) => {
        outcomes.push([request.ref, reason(outcome)]);
        if (outcomes.length === 6) done();
      },
    );
    const req = (ref: string, path: string): FetchRequest => ({
      type: 'fetch',
      viewKey: 'v',
      ref,
      url: s.url(path),
    });
    for (let i = 1; i <= 5; i += 1) scheduler.fetch(req(`r${i}`, '/five'));
    await new Promise<void>((r) => {
      const check = () => (outcomes.length === 5 ? r() : setTimeout(check, 5));
      check();
    });
    scheduler.fetch(req('r6', '/small'));
    await all;
    expect(outcomes.sort()).toEqual([
      ['r1', 'ok'],
      ['r2', 'ok'],
      ['r3', 'ok'],
      ['r4', 'ok'],
      ['r5', 'ok'],
      ['r6', 'total'],
    ]);
  });

  it('times out after the wall-clock budget, also while DNS hangs, and ignores a late answer', async () => {
    const s = await serve({ '/never': never });
    const { env } = envFor(s.port, { imageMaxMs: 200 });
    expect(reason(await get(s.url('/never'), env))).toBe('timeout');
    let late!: () => void;
    const hanging = envFor(s.port, {
      imageMaxMs: 200,
      resolve: (_h, _o, cb) => {
        late = () => cb(null, [{ address: '127.0.0.1', family: 4 }]);
      },
    });
    const before = s.connections();
    expect(reason(await get(s.url('/a.png', 'http', 'slow.test'), hanging.env))).toBe('timeout');
    late();
    await new Promise((r) => setTimeout(r, 100));
    expect(s.connections()).toBe(before);
    expect(hanging.destinations).toEqual([]);
  });

  it('an abort ends a request at once', async () => {
    const s = await serve({ '/never': never });
    const { env } = envFor(s.port);
    const controller = new AbortController();
    const pending = get(s.url('/never'), env, unlimited, controller.signal);
    while (s.seen.length === 0) await new Promise((r) => setTimeout(r, 5));
    const started = performance.now();
    controller.abort();
    expect(reason(await pending)).toBe('aborted');
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('aborting a view stops its in-flight and waiting requests, and reports neither', async () => {
    const s = await serve({ '/never': never, '/a.png': png });
    const { env } = envFor(s.port);
    const outcomes: string[] = [];
    const scheduler = new ViewScheduler(
      (url, view, signal) => fetchImage(url, view, signal, env),
      (request) => outcomes.push(request.ref),
    );
    for (let i = 0; i < 8; i += 1) {
      scheduler.fetch({ type: 'fetch', viewKey: 'v', ref: `r${i}`, url: s.url('/never') });
    }
    while (s.seen.length < 6) await new Promise((r) => setTimeout(r, 5));
    expect(scheduler.pending('v')).toBe(8);
    scheduler.abort('v');
    expect(scheduler.pending('v')).toBe(0);
    // Another view is unaffected.
    scheduler.fetch({ type: 'fetch', viewKey: 'w', ref: 'ok', url: s.url('/a.png') });
    while (outcomes.length === 0) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 50));
    expect(outcomes).toEqual(['ok']);
    expect(s.seen.filter((x) => x.url === '/never')).toHaveLength(6);
  });
});
