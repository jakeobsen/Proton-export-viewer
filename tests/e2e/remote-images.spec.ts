// SPDX-License-Identifier: AGPL-3.0-or-later
// Remote images in the running app. Before consent every image is the
// placeholder, nothing reaches the server and no fetcher runs. "Load external
// images" on the message's banner loads them through the fetcher only, once
// per image, with one reload of the body frame; the consent holds for that
// open alone. The banner counts images that came over http and images that
// couldn't load. A new open aborts what is in flight, and the fetcher exits
// once no open view allows remote images.

import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { AllowRemoteResult, MessageOpenResult } from '../../src/shared/api';
import { apng, dimensionBombPng, solidPng } from '../../tools/gen-export/images.mjs';
import { MARKERS, findMarkers } from '../markers';
import { testDir } from '../paths';
import { writeThreads } from '../thread-export';
import { expect, test, type PevApp } from './app';

const PNG = solidPng(2, 2, [10, 20, 30]);
const MB = 1024 * 1024;

type Route = (req: IncomingMessage, res: ServerResponse) => void;

/** A loopback http server with routes by path prefix; it records each request's path. */
async function serve(routes: Array<[string, Route]>) {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    const path = req.url ?? '';
    seen.push(path);
    const route = routes.find(([prefix]) => path.startsWith(prefix));
    if (route) route[1](req, res);
    else res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    port,
    seen,
    url: (path: string) => `http://127.0.0.1:${port}${path}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const png: Route = (_q, res) => res.writeHead(200, { 'Content-Type': 'image/png' }).end(PNG);

function html(subject: string, body: string): string {
  return [
    `Subject: ${subject}`,
    'From: <sender@example.org>',
    'To: <owner@example.com>',
    'Date: Mon, 1 Jan 2024 10:00:00 +0000',
    'Content-Type: text/html; charset=utf-8',
    '',
    body,
    '',
  ].join('\r\n');
}

/** Gives core a reader source of these messages, rowid 1 first. */
async function source(pev: PevApp, messages: string[]): Promise<void> {
  const root = testDir('remote-root');
  const entries = messages.map((text, i) => {
    writeFileSync(join(root, `m${i + 1}.eml`), text);
    return [i + 1, { file: `m${i + 1}.eml` }] as const;
  });
  expect((await pev.main<{ ok: boolean }>('readerSource', root, entries)).ok).toBe(true);
}

/** Opens a message in the pane and waits until its frame shows it. */
async function openShown(pev: PevApp, rowid: number) {
  const opened = await pev.shell<MessageOpenResult>('openInReader', [rowid]);
  if (!opened.ok || opened.outcome !== 'view') throw new Error('not opened');
  await expect.poll(() => pev.page.locator('.rp-frame').getAttribute('src')).toBe(opened.url);
  await pev.bodyFrame(opened.url);
  return opened;
}

/** The natural width of each image in the shown body: 1 for the placeholder. */
async function widths(pev: PevApp, url: string): Promise<number[]> {
  const frame = pev.page.frames().find((f) => f.url() === url);
  if (!frame) return [];
  return frame
    .locator('img')
    .evaluateAll((imgs) =>
      imgs.map((i) =>
        (i as HTMLImageElement).complete ? (i as HTMLImageElement).naturalWidth : -1,
      ),
    )
    .catch(() => []);
}

const banner = (pev: PevApp) => pev.page.locator('.rp-images b');
const button = (pev: PevApp) => pev.page.locator('.rp-load-images');

async function bodyLoads(pev: PevApp, url: string): Promise<number> {
  const seen = await pev.main<{ body: string[] }>('requests', 1);
  return seen.body.filter((u) => u === url).length;
}

/** The app's processes other than this test's that have a TCP socket to `port`. */
function socketOwners(port: number): number[] {
  let out = '';
  try {
    out = execFileSync(
      'lsof',
      ['-n', '-P', `-iTCP@127.0.0.1:${port}`, '-sTCP:ESTABLISHED', '-Fp'],
      {
        encoding: 'utf8',
      },
    );
  } catch {
    // lsof exits 1 when it finds nothing.
  }
  const pids = out
    .split('\n')
    .filter((l) => l.startsWith('p'))
    .map((l) => Number(l.slice(1)));
  return [...new Set(pids)].filter((pid) => pid !== process.pid).sort();
}

test('consent loads the images through the fetcher alone; before it nothing is fetched and no fetcher runs', async ({
  pev,
}) => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  const s = await serve([
    ['/a.png', png],
    ['/held.png', (q, res) => void held.then(() => png(q, res))],
  ]);
  try {
    await pev.main('fetcherAllow', '127.0.0.1', s.port);
    await source(pev, [
      html('Pictures', `<img src="${s.url('/a.png')}"><img src="${s.url('/held.png')}">`),
    ]);
    const opened = await openShown(pev, 1);
    expect(opened).toMatchObject({ remote: 2, remoteLoadable: true });
    await expect.poll(() => widths(pev, opened.url)).toEqual([1, 1]);
    await expect(banner(pev)).toHaveText('2 external images blocked');
    expect(s.seen).toEqual([]);
    expect(await pev.main('fetcherPid')).toBeNull();

    await button(pev).click();
    await expect.poll(() => s.seen.includes('/held.png')).toBe(true);
    const pid = await pev.main<number | null>('fetcherPid');
    expect(pid).not.toBeNull();
    // The held image's connection is the fetcher's, and no other process's of the app.
    await expect.poll(() => socketOwners(s.port)).toEqual([pid]);
    release();
    await expect.poll(() => widths(pev, opened.url)).toEqual([2, 2]);
    await expect(banner(pev)).toHaveText('External images loaded · 2 not secure');
    expect([...s.seen].sort()).toEqual(['/a.png', '/held.png']);
    const destinations =
      await pev.main<Array<{ address: string; port: number }>>('fetcherDestinations');
    expect(destinations.length).toBeGreaterThan(0);
    expect(new Set(destinations.map((d) => `${d.address}:${d.port}`))).toEqual(
      new Set([`127.0.0.1:${s.port}`]),
    );
    // The body frame asked main for its images; nothing went to the network from it.
    const seen = await pev.main<{ blocked: string[]; asset: string[] }>('requests', 1);
    expect(seen.blocked).toEqual([]);
    expect(seen.asset.filter((u) => /\/r[12]$/.test(u)).length).toBeGreaterThanOrEqual(2);
    expect(await pev.main('remoteView', 1)).toMatchObject({
      consent: 'allowed',
      hasKey: true,
      keyIsToken: false,
      loads: 0,
    });
    expect(pev.hasLog('remote.allowed')).toBe(true);
  } finally {
    release();
    await s.close();
  }
});

test('consent holds for that open alone: not the next message, not another window, not an old open', async ({
  pev,
}) => {
  const s = await serve([['/', png]]);
  try {
    await pev.main('fetcherAllow', '127.0.0.1', s.port);
    await source(pev, [
      html('One', `<img src="${s.url('/one.png')}">`),
      html('Two', `<img src="${s.url('/two.png')}">`),
    ]);
    const first = await openShown(pev, 1);
    await button(pev).click();
    await expect.poll(() => widths(pev, first.url)).toEqual([2]);

    // The next message: placeholders again, nothing fetched, and the fetcher exits.
    const second = await openShown(pev, 2);
    await expect.poll(() => widths(pev, second.url)).toEqual([1]);
    await expect(banner(pev)).toHaveText('1 external image blocked');
    expect(s.seen).toEqual(['/one.png']);
    await expect.poll(() => pev.main('fetcherPid')).toBeNull();
    expect(pev.hasLog('fetcher.stopped', { reason: 'idle' })).toBe(true);

    // The first open's id can't consent any more.
    const generation = (await pev.shell<{ generation: number }>('state')).generation;
    const stale = await pev.page.evaluate(
      ([openId, gen]) =>
        window.__pevTestIpc.invoke('pev:allow-remote', { openId, generation: gen }),
      [first.openId, generation] as const,
    );
    expect(stale).toEqual({ ok: false, code: 'not_live' });

    // Message 1 in another window shows placeholders.
    const other = await pev.openWindow('shell');
    const again = await pev.shell<MessageOpenResult>('openInReader', [1], other.page);
    if (!again.ok || again.outcome !== 'view') throw new Error('not opened');
    await pev.bodyFrame(again.url, other.page);
    const frame = other.page.frames().find((f) => f.url() === again.url)!;
    await expect
      .poll(() =>
        frame
          .locator('img')
          .evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).naturalWidth)),
      )
      .toEqual([1]);
    expect(s.seen).toEqual(['/one.png']);
  } finally {
    await s.close();
  }
});

test('a new open while an image is on its way aborts it, and the fetcher exits', async ({
  pev,
}) => {
  const s = await serve([['/held.png', () => undefined]]);
  try {
    await pev.main('fetcherAllow', '127.0.0.1', s.port);
    await source(pev, [
      html('Held', `<img src="${s.url('/held.png')}">`),
      html('Plain', '<p>no images</p>'),
    ]);
    await openShown(pev, 1);
    await button(pev).click();
    await expect.poll(() => s.seen).toEqual(['/held.png']);
    expect(await pev.main('fetcherPid')).not.toBeNull();
    await openShown(pev, 2);
    await expect.poll(() => pev.main('fetcherPid')).toBeNull();
    expect(s.seen).toEqual(['/held.png']);
  } finally {
    await s.close();
  }
});

test('nothing is fetched before the frame asks: an unchosen srcset candidate is never requested', async ({
  pev,
}) => {
  const s = await serve([['/', png]]);
  try {
    await pev.main('fetcherAllow', '127.0.0.1', s.port);
    await source(pev, [
      html('Srcset', `<img srcset="${s.url('/low.png')} 1x, ${s.url('/high.png')} 3x">`),
    ]);
    const opened = await openShown(pev, 1);
    await button(pev).click();
    await expect.poll(() => widths(pev, opened.url)).toEqual([2]);
    expect(s.seen).toHaveLength(1);
    expect(['/low.png', '/high.png']).toContain(s.seen[0]);
  } finally {
    await s.close();
  }
});

/** A remote image that fails main's and the fetcher's raster check, by class. */
const BOMBS: Array<[string, Uint8Array]> = [
  ['format', Buffer.from('not an image')],
  ['canvas', dimensionBombPng(30000, 30000)],
  ['frames', apng(2, 2, 1, { declared: 1001 })],
  ['pixels', apng(8000, 5000, 6)],
  ['container', PNG.subarray(0, 30)],
];

test('the banner counts http images and the ones that could not load, which keep the placeholder', async ({
  pev,
}) => {
  const s = await serve([
    ['/ok.png', png],
    ...BOMBS.map(([reason, bytes]): [string, Route] => [
      `/${reason}.png`,
      (_q, res) => res.writeHead(200, { 'Content-Type': 'image/png' }).end(bytes),
    ]),
  ]);
  try {
    await pev.main('fetcherAllow', '127.0.0.1', s.port);
    const paths = ['/ok.png', ...BOMBS.map(([reason]) => `/${reason}.png`), '/missing.png'];
    await source(pev, [html('Mixed', paths.map((p) => `<img src="${s.url(p)}">`).join(''))]);
    const opened = await openShown(pev, 1);
    await button(pev).click();
    await expect(banner(pev)).toHaveText("External images loaded · 1 not secure · 6 couldn't load");
    await expect.poll(() => widths(pev, opened.url)).toEqual([2, 1, 1, 1, 1, 1, 1]);
    expect(await pev.main('remoteView', 1)).toMatchObject({ insecure: 1, refused: 6 });
    for (const reason of [...BOMBS.map(([r]) => r), 'status']) {
      expect(pev.hasLog('fetcher.refused', { proc: 'fetcher', reason })).toBe(true);
    }
  } finally {
    await s.close();
  }
});

test('each image keeps to its budgets: 10 s, 5 MB, 5 redirects', async ({ pev }) => {
  test.setTimeout(90_000);
  const big = Buffer.concat([PNG, Buffer.alloc(6 * MB)]);
  const s = await serve([
    ['/slow.png', () => undefined],
    ['/big.png', (_q, res) => res.writeHead(200, { 'Content-Type': 'image/png' }).end(big)],
    [
      '/hop/',
      (q, res) => {
        const n = Number((q.url ?? '').split('/')[2]);
        res.writeHead(302, { Location: `/hop/${n + 1}` }).end();
      },
    ],
  ]);
  try {
    await pev.main('fetcherAllow', '127.0.0.1', s.port);
    await source(pev, [
      html(
        'Budgets',
        ['/slow.png', '/big.png', '/hop/0'].map((p) => `<img src="${s.url(p)}">`).join(''),
      ),
    ]);
    const opened = await openShown(pev, 1);
    const started = Date.now();
    await button(pev).click();
    await expect(banner(pev)).toHaveText("External images loaded · 3 couldn't load", {
      timeout: 30_000,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(9_000);
    await expect.poll(() => widths(pev, opened.url)).toEqual([1, 1, 1]);
    // The first request and five redirects; the sixth is refused.
    expect(s.seen.filter((p) => p.startsWith('/hop/'))).toEqual([
      '/hop/0',
      '/hop/1',
      '/hop/2',
      '/hop/3',
      '/hop/4',
      '/hop/5',
    ]);
    for (const reason of ['timeout', 'too_large', 'redirects']) {
      expect(pev.hasLog('fetcher.refused', { proc: 'fetcher', reason })).toBe(true);
    }
  } finally {
    await s.close();
  }
});

test('a view starts at most 100 images; the 101st keeps the placeholder', async ({ pev }) => {
  test.setTimeout(60_000);
  const s = await serve([['/i/', png]]);
  try {
    await pev.main('fetcherAllow', '127.0.0.1', s.port);
    const images = Array.from({ length: 101 }, (_, i) => `<img src="${s.url(`/i/${i}.png`)}">`);
    await source(pev, [html('Many', images.join(''))]);
    const opened = await openShown(pev, 1);
    await button(pev).click();
    await expect(banner(pev)).toHaveText(
      "External images loaded · 100 not secure · 1 couldn't load",
      {
        timeout: 30_000,
      },
    );
    const shown = await widths(pev, opened.url);
    expect(shown.filter((w) => w === 2)).toHaveLength(100);
    expect(shown.filter((w) => w === 1)).toHaveLength(1);
    expect(new Set(s.seen).size).toBe(100);
  } finally {
    await s.close();
  }
});

test('one consent, one reload: a double click and repeated requests while the fetcher starts', async ({
  pev,
}) => {
  const s = await serve([['/', png]]);
  try {
    await pev.main('fetcherAllow', '127.0.0.1', s.port);
    await source(pev, [
      html('Twice', `<img src="${s.url('/a.png')}"><img src="${s.url('/b.png')}">`),
    ]);
    const opened = await openShown(pev, 1);
    expect(await bodyLoads(pev, opened.url)).toBe(1);
    await pev.main('holdRemoteConsent');
    await button(pev).dblclick({ force: true });
    await expect(button(pev)).toBeDisabled();
    const generation = (await pev.shell<{ generation: number }>('state')).generation;
    const ask = () =>
      pev.page.evaluate(
        ([openId, gen]) =>
          window.__pevTestIpc.invoke('pev:allow-remote', { openId, generation: gen }),
        [opened.openId, generation] as const,
      ) as Promise<AllowRemoteResult>;
    const extra = [ask(), ask()];
    await pev.main('releaseRemoteConsent');
    expect(await Promise.all(extra)).toEqual([
      { ok: true, reload: false },
      { ok: true, reload: false },
    ]);
    await expect.poll(() => widths(pev, opened.url)).toEqual([2, 2]);
    expect(await pev.main('remoteAttempts')).toBe(1);
    expect(await bodyLoads(pev, opened.url)).toBe(2);
    expect([...s.seen].sort()).toEqual(['/a.png', '/b.png']);
  } finally {
    await s.close();
  }
});

test('after the consent reload, a third load of the body is refused and the images stay', async ({
  pev,
}) => {
  const s = await serve([['/', png]]);
  try {
    await pev.main('fetcherAllow', '127.0.0.1', s.port);
    await source(pev, [html('Thrice', `<img src="${s.url('/a.png')}">`)]);
    const opened = await openShown(pev, 1);
    await button(pev).click();
    await expect.poll(() => widths(pev, opened.url)).toEqual([2]);
    expect(await bodyLoads(pev, opened.url)).toBe(2);
    // The shell loads the same URL again.
    await pev.page
      .locator('.rp-frame')
      .evaluate((f, url) => ((f as HTMLIFrameElement).src = url), opened.url);
    await expect.poll(() => pev.hasLog('nav.denied', { reason: 'reload_spent' })).toBe(true);
    expect(await bodyLoads(pev, opened.url)).toBe(2);
    expect(await widths(pev, opened.url)).toEqual([2]);
  } finally {
    await s.close();
  }
});

test('nothing else reloads the frame: theme, size, focus and the details line', async ({ pev }) => {
  const s = await serve([['/', png]]);
  try {
    await pev.main('fetcherAllow', '127.0.0.1', s.port);
    await source(pev, [html('Stay', `<img src="${s.url('/a.png')}">`)]);
    const opened = await openShown(pev, 1);
    await button(pev).click();
    await expect.poll(() => widths(pev, opened.url)).toEqual([2]);
    expect(await bodyLoads(pev, opened.url)).toBe(2);

    await pev.page.emulateMedia({ colorScheme: 'dark' });
    await pev.page.emulateMedia({ colorScheme: 'light' });
    await pev.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win?.setSize(900, 640);
      win?.setSize(1100, 720);
    });
    await pev.page.evaluate(() => {
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new Event('focus'));
    });
    await pev.page.locator('.rp-linkish').click();
    await pev.page.locator('.rp-linkish').click();
    await pev.page.waitForTimeout(500);

    expect(await bodyLoads(pev, opened.url)).toBe(2);
    expect(pev.hasLog('nav.denied', { reason: 'reload_spent' })).toBe(false);
    expect(await widths(pev, opened.url)).toEqual([2]);
    await expect(banner(pev)).toHaveText('External images loaded · 1 not secure');
  } finally {
    await s.close();
  }
});

/** Hidden windows get no frames to click in: events are sent directly. */
const press = (pev: PevApp, selector: string) => pev.page.locator(selector).dispatchEvent('click');

test('nothing else reloads the frame in a long conversation: Settings, the report, the cards scrolled away and back', async ({
  pev,
}) => {
  test.setTimeout(90_000);
  const s = await serve([['/', png]]);
  try {
    await pev.main('fetcherAllow', '127.0.0.1', s.port);
    const root = realpathSync(testDir('remote-conversation'));
    const written = writeThreads(root, { seed: 74, threads: [{ messages: 60 }, { messages: 1 }] });
    // The newest message, the one expanded when the conversation opens, is HTML
    // with one remote image.
    const newest = join(written.run, `${written.threads[0]!.ids.at(-1)!}.eml`);
    const eml = readFileSync(newest, 'utf8');
    const head = eml.slice(0, eml.indexOf('\r\n\r\n'));
    writeFileSync(
      newest,
      `${head.replace('Content-Type: text/plain', 'Content-Type: text/html')}\r\n\r\n` +
        `<p>Stay</p><img src="${s.url('/a.png')}">\r\n`,
    );
    // A message file without its metadata, so the list header links to the report.
    rmSync(join(written.run, `${written.threads[1]!.ids[0]!}.metadata.json`));
    await pev.main('queuePick', root, 'bm1');
    await pev.shell('chooseFolder', []);
    await expect
      .poll(
        async () =>
          (await pev.main<{ progress: { phase: string } } | null>('indexQuery', { op: 'totals' }))
            ?.progress.phase,
        { timeout: 30_000 },
      )
      .toBe('done');
    await press(pev, '[data-folder="5"]');
    await press(pev, '.list-scroll .conv >> nth=0');
    await expect
      .poll(async () => (await pev.shell<{ view: { url: string } | null }>('reader')).view?.url)
      .toBeTruthy();
    const url = (await pev.shell<{ view: { url: string } }>('reader')).view.url;
    const frame = pev.page.locator('.card.expanded .rp-frame');
    await expect(frame).toHaveAttribute('src', url);
    await pev.bodyFrame(url);
    await press(pev, '.card.expanded .rp-load-images');
    await expect.poll(() => widths(pev, url)).toEqual([2]);
    expect(await bodyLoads(pev, url)).toBe(2);

    // Settings and back to mail.
    await pev.page.getByRole('button', { name: 'Settings', exact: true }).dispatchEvent('click');
    await expect(pev.page.locator('main.settings')).toBeVisible();
    await pev.page
      .getByRole('button', { name: 'Back to mail', exact: true })
      .dispatchEvent('click');
    await expect(pev.page.locator('main.settings')).toHaveCount(0);
    await expect(frame).toBeVisible();

    // The index report and back.
    await expect(pev.page.locator('.list-head .attention')).toHaveCount(1);
    await press(pev, '.list-head .attention');
    await expect(pev.page.locator('.ix-card')).toHaveCount(1);
    await press(pev, '.ix-foot button:text("Start browsing")');
    await expect(pev.page.locator('.ix-card')).toHaveCount(0);
    await expect(frame).toBeVisible();

    // The cards scrolled to the oldest message, out of the drawn range, and back.
    const scrollCards = (to: 'top' | 'end') =>
      pev.page.locator('.cv-scroll').evaluate((e, where) => {
        e.scrollTop = where === 'top' ? 0 : e.scrollHeight;
        e.dispatchEvent(new Event('scroll'));
      }, to);
    await scrollCards('top');
    await expect(pev.page.locator('.card .ch-name').first()).toHaveText('Sender 0');
    await scrollCards('end');
    await expect(frame).toHaveAttribute('src', url);
    await pev.page.waitForTimeout(500);

    expect(await bodyLoads(pev, url)).toBe(2);
    expect(pev.hasLog('nav.denied', { reason: 'reload_spent' })).toBe(false);
    expect(await widths(pev, url)).toEqual([2]);
    await expect(banner(pev)).toHaveText('External images loaded · 1 not secure');
    expect(s.seen.filter((p) => p === '/a.png')).toHaveLength(1);
  } finally {
    await s.close();
  }
});

test('no marker in a remote URL or host name reaches a log after consent', async ({ pev }) => {
  test.setTimeout(60_000);
  const [email, , , tracker, host, file] = MARKERS;
  const marked = `/${encodeURIComponent(file)}?u=${encodeURIComponent(tracker)}&e=${encodeURIComponent(email)}`;
  let holds = 0;
  const s = await serve([
    ['/ok/', png],
    ['/missing/', (_q, res) => res.writeHead(404).end()],
    ['/redirect/', (_q, res) => res.writeHead(302, { Location: `/ok/r${marked}` }).end()],
    [
      '/elsewhere/',
      (_q, res) => res.writeHead(302, { Location: `http://${host}:8080${marked}` }).end(),
    ],
    ['/slow/', () => undefined],
    ['/hold/', () => (holds += 1)],
  ]);
  try {
    await pev.main('fetcherAllow', '127.0.0.1', s.port);
    const paths = ['/ok/', '/missing/', '/redirect/', '/elsewhere/', '/slow/'].map((p) =>
      s.url(`${p}x${marked}`),
    );
    await source(pev, [
      html(
        `Hello ${email}`,
        paths.map((u) => `<img src="${u}">`).join('') +
          `<img src="http://${host}/${encodeURIComponent(file)}.png">`,
      ),
      html('Held', `<img src="${s.url(`/hold/x${marked}`)}">`),
    ]);
    await openShown(pev, 1);
    await button(pev).click();
    await expect(banner(pev)).toHaveText(
      "External images loaded · 2 not secure · 4 couldn't load",
      {
        timeout: 30_000,
      },
    );

    // A crash with an image in flight.
    await openShown(pev, 2);
    await button(pev).click();
    await expect.poll(() => holds).toBe(1);
    const pid = await pev.main<number>('fetcherPid');
    process.kill(pid, 'SIGKILL');
    await expect.poll(() => pev.hasLog('fetcher.exit')).toBe(true);
    await expect(banner(pev)).toHaveText("External images loaded · 1 couldn't load");

    const files = readdirSync(pev.logsDir());
    const text = files.map((f) => readFileSync(join(pev.logsDir(), f), 'utf8')).join('\n');
    expect(findMarkers(text)).toEqual([]);
    expect(pev.hasLog('remote.allowed')).toBe(true);
    expect(pev.hasLog('remote.served')).toBe(true);
  } finally {
    await s.close();
  }
});
