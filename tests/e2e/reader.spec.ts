// SPDX-License-Identifier: AGPL-3.0-or-later
// Opening a message through the reader lane: the test source, plain text
// served by mail-body:, stale opens, the lane's limits and its fallback, and
// the malformed-MIME and odd-charset messages of the hostile corpus.

import { randomBytes } from 'node:crypto';
import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { MessageOpenResult } from '../../src/shared/api';
import { BODY_CSP } from '../../src/shared/constants';
import type { OpenMode, TestInput } from '../../src/shared/reader-protocol';
import { hostileMessages } from '../../tools/gen-export/hostile.mjs';
import { solidPng } from '../../tools/gen-export/images.mjs';
import { testDir } from '../paths';
import { expect, test, tokenOf, type PevApp } from './app';

type Entry = ({ file: string } | { test: TestInput }) & { gate?: string };

const PLAIN = [
  'Subject: Plain <b>subject</b>',
  'From: "Sender" <sender@example.org>',
  'To: <owner@example.com>',
  'Date: Mon, 1 Jan 2024 10:00:00 +0000',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Hello <script>document.title="ran"</script> & welcome.',
  'Read https://leak-reader.test/a?b=1 or mailto:x@leak-reader.test.',
  'Not javascript:alert(1).',
  '',
].join('\r\n');

/** Writes files under a new test folder and makes it the reader's source. */
async function source(
  pev: PevApp,
  files: Record<string, string | Buffer>,
  entries: Array<[number, Entry]>,
  links: Array<[string, string]> = [],
): Promise<string> {
  const root = testDir('reader-root');
  for (const [name, data] of Object.entries(files)) writeFileSync(join(root, name), data);
  for (const [name, target] of links) symlinkSync(join(root, target), join(root, name));
  const result = await pev.main<{ ok: boolean }>('readerSource', root, entries);
  expect(result.ok).toBe(true);
  return root;
}

function openRow(
  pev: PevApp,
  rowid: number,
  mode: OpenMode = 'plain',
  page: Page = pev.page,
): Promise<MessageOpenResult> {
  return page.evaluate(
    async ([r, m]) => {
      const state = await window.pev.state();
      if (!state.ok) return state;
      return window.pev.open(r as number, m as OpenMode, state.generation);
    },
    [rowid, mode] as const,
  );
}

async function startOpen(pev: PevApp, rowid: number, slot: string): Promise<void> {
  await pev.page.evaluate(
    async ([r, key]) => {
      const state = await window.pev.state();
      const generation = state.ok ? state.generation : 0;
      (window as unknown as Record<string, unknown>)[key as string] = window.pev.open(
        r as number,
        'plain',
        generation,
      );
    },
    [rowid, slot] as const,
  );
}

function finishOpen(pev: PevApp, slot: string): Promise<MessageOpenResult> {
  return pev.page.evaluate(
    (key) => (window as unknown as Record<string, Promise<MessageOpenResult>>)[key]!,
    slot,
  );
}

function viewUrl(result: MessageOpenResult): string {
  if (!result.ok || result.outcome !== 'view')
    throw new Error(`no view: ${JSON.stringify(result)}`);
  return result.url;
}

async function laneInfo(pev: PevApp) {
  const result = await pev.main<{
    data: { threadId: number | null; heapMb: number | null; queued: number };
  }>('core', 'reader-lane');
  return result.data;
}

/** How many lookups wait at a gate of the test source. */
async function gateWaiting(pev: PevApp, name: string): Promise<number> {
  return (await pev.main<{ value: number }>('readerGateWaiting', name)).value;
}

test('a message opens as plain text, served by mail-body: with its body headers', async ({
  pev,
}) => {
  await source(pev, { 'plain.eml': PLAIN }, [[1, { file: 'plain.eml' }]]);
  const opened = await openRow(pev, 1);
  expect(opened).toMatchObject({
    ok: true,
    outcome: 'view',
    format: 'plain',
    hasHtml: false,
    headers: {
      subject: 'Plain <b>subject</b>',
      from: '"Sender" <sender@example.org>',
      to: 'owner@example.com',
      cc: '',
      date: '2024-01-01T10:00:00.000Z',
    },
  });
  const url = viewUrl(opened);
  const token = tokenOf(url);

  const body = await pev.main<{ status: number; headers: Record<string, string> }>(
    'fetchIn',
    1,
    url,
  );
  expect(body.status).toBe(200);
  expect(body.headers).toEqual({
    'content-security-policy': BODY_CSP,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-type': 'text/html; charset=utf-8',
  });

  // Main keeps each link's URL; the body only has its id, which is never served.
  expect(await pev.main('viewLinks', 1, token)).toEqual([
    ['l1', { url: 'https://leak-reader.test/a?b=1', text: 'https://leak-reader.test/a?b=1' }],
    ['l2', { url: 'mailto:x@leak-reader.test', text: 'mailto:x@leak-reader.test' }],
  ]);
  for (const id of ['l1', 'l2']) {
    const asset = await pev.main<{ status: number }>('fetchIn', 1, `mail-asset://v/${token}/${id}`);
    expect(asset.status).toBe(404);
  }

  // The body renders in the sandboxed frame: text only, links by id.
  await pev.open('sample');
  const second = await openRow(pev, 1);
  const secondUrl = viewUrl(second);
  await pev.shell('setFrameSrc', [secondUrl]);
  const frame = await pev.bodyFrame(secondUrl);
  const rendered = await frame.evaluate(() => ({
    text: document.querySelector('pre')?.textContent ?? '',
    hrefs: [...document.querySelectorAll('a')].map((a) => a.getAttribute('href')),
    scripts: document.querySelectorAll('script').length,
    title: document.title,
  }));
  const secondToken = tokenOf(secondUrl);
  expect(rendered).toEqual({
    text: PLAIN.split('\r\n\r\n')[1]!.replace(/\r\n/g, '\n'),
    hrefs: [`mail-asset://v/${secondToken}/l1`, `mail-asset://v/${secondToken}/l2`],
    scripts: 0,
    title: '',
  });

  // A click on a link opens the link dialog through its id, and navigates nowhere.
  await frame.evaluate(() => (document.querySelector('a') as HTMLAnchorElement).click());
  await expect
    .poll(() => pev.main('linkDialogs'))
    .toMatchObject([
      {
        windowId: 1,
        url: 'https://leak-reader.test/a?b=1',
        title: 'https://leak-reader.test/a?b=1',
        mismatch: false,
        lookalike: false,
      },
    ]);
  await expect(pev.page.locator('.link-url')).toHaveText('https://leak-reader.test/a?b=1');
  expect(pev.app.windows()).toHaveLength(1);
  expect(frame.url()).toBe(secondUrl);
});

/** The HTML message's cid: part: a PNG that isn't the placeholder. */
const INLINE_PNG = solidPng(2, 2, [10, 20, 30]);

const HTML = [
  'Subject: HTML body',
  'From: "Sender" <sender@example.org>',
  'Content-Type: multipart/related; boundary="rel"',
  '',
  '--rel',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<html><head><style>p{color:red}</style><link rel="stylesheet" href="https://leak-reader.test/s.css">',
  '<meta http-equiv="refresh" content="0;url=https://leak-reader.test/r"></head>',
  '<body><p id="p" style="color:blue">Hello</p>',
  '<div id="bg" style="background-image:url(https://leak-reader.test/bg.png);width:4px;height:4px"></div>',
  '<img id="remote" src="https://leak-reader.test/pixel.png" width="1" height="1">',
  '<img id="inline" src="cid:part1@example.org">',
  '<a id="link" href="https://leak-reader.test/page">a page</a>',
  `<script>document.documentElement.setAttribute('data-pev-script','ran')</script>`,
  '<iframe src="https://leak-reader.test/frame"></iframe></body></html>',
  '--rel',
  'Content-Type: image/png',
  'Content-ID: <part1@example.org>',
  'Content-Transfer-Encoding: base64',
  '',
  INLINE_PNG.toString('base64'),
  '--rel--',
  '',
].join('\r\n');

test('an HTML message opens sanitized, with placeholders, and requests nothing remote', async ({
  pev,
}) => {
  await source(pev, { 'html.eml': HTML }, [[1, { file: 'html.eml' }]]);
  // A first body puts the frame in place; let it finish loading before the record starts.
  const sample = await pev.open('sample');
  await pev.bodyFrame(sample.url as string);
  await pev.main('clearRequests');
  const before = pev.consoleMessages.length;
  const opened = await openRow(pev, 1, 'html');
  expect(opened).toMatchObject({
    ok: true,
    outcome: 'view',
    format: 'html',
    hasHtml: true,
    remote: 2,
  });
  const url = viewUrl(opened);
  const token = tokenOf(url);
  await pev.shell('setFrameSrc', [url]);
  const frame = await pev.bodyFrame(url);
  await expect
    .poll(() =>
      frame.evaluate(() => {
        const img = document.getElementById('remote') as HTMLImageElement | null;
        return img?.complete ? img.naturalWidth : -1;
      }),
    )
    .toBe(1);
  const dom = await frame.evaluate(() => ({
    remote: document.getElementById('remote')?.getAttribute('src'),
    inline: document.getElementById('inline')?.getAttribute('src'),
    link: document.getElementById('link')?.getAttribute('href'),
    target: document.getElementById('link')?.getAttribute('target'),
    style: document.getElementById('p')?.getAttribute('style') ?? null,
    color: getComputedStyle(document.getElementById('p') as HTMLElement).color,
    background: getComputedStyle(document.getElementById('bg') as HTMLElement).backgroundImage,
    sheets: [...document.querySelectorAll('style')].map((e) => e.textContent),
    dropped: document.querySelectorAll('script, link, meta, iframe').length,
    ran: document.documentElement.getAttribute('data-pev-script'),
  }));
  expect(dom).toEqual({
    remote: `mail-asset://v/${token}/r1`,
    inline: `mail-asset://v/${token}/c1`,
    link: `mail-asset://v/${token}/l1`,
    target: '_blank',
    // The style sheet and the style attributes stay, filtered, and render.
    style: 'color:blue',
    color: 'rgb(0, 0, 255)',
    background: `url("mail-asset://v/${token}/r2")`,
    sheets: ['p{color:red}'],
    dropped: 0,
    ran: null,
  });

  await expect
    .poll(async () =>
      (await pev.main<{ asset: string[] }>('requests', 1)).asset.includes(
        `mail-asset://v/${token}/r2`,
      ),
    )
    .toBe(true);

  // The placeholder serves, and so does the cid part, as the PNG it is; a
  // link id serves nothing.
  const asset = (id: string) =>
    pev.main<{ status: number; headers: Record<string, string>; length: number }>(
      'fetchIn',
      1,
      `mail-asset://v/${token}/${id}`,
    );
  expect(await asset('r1')).toMatchObject({ status: 200, length: 68 });
  expect((await asset('r1')).headers['content-type']).toBe('image/png');
  expect(await asset('c1')).toMatchObject({ status: 200, length: INLINE_PNG.length });
  expect((await asset('c1')).headers['content-type']).toBe('image/png');
  expect((await asset('l1')).status).toBe(404);

  // Nothing but this view's own URLs was requested, nothing was cancelled,
  // and the body caused no CSP report.
  const requests = await pev.main<{ body: string[]; asset: string[]; blocked: string[] }>(
    'requests',
    1,
  );
  expect(requests.blocked).toEqual([]);
  expect(requests.body.every((u) => u === url)).toBe(true);
  expect(requests.asset.every((u) => u.startsWith(`mail-asset://v/${token}/`))).toBe(true);
  const reports = pev.consoleMessages
    .slice(before)
    .filter((m) => /Content Security Policy/i.test(m.text));
  expect(reports).toEqual([]);
});

test('the huge-style and regex-heavy messages open in time or fall back', async ({ pev }) => {
  const { plans } = hostileMessages({
    seed: 1,
    nonce: randomBytes(6).toString('hex'),
    labelInfo: { file: { Payload: [] } },
    owner: { Name: 'Owner', Address: 'owner@example.com' },
  });
  const chosen = plans.filter((p) =>
    ['pathological/huge-style', 'pathological/regex-heavy-css'].includes(
      p.key.split('/').slice(3).join('/'),
    ),
  );
  expect(chosen).toHaveLength(2);
  await source(
    pev,
    Object.fromEntries(chosen.map((p, i) => [`p${i}.eml`, p.emlData])),
    chosen.map((_p, i) => [i + 1, { file: `p${i}.eml` }] as [number, Entry]),
  );
  for (const [i, plan] of chosen.entries()) {
    const started = Date.now();
    const result = await openRow(pev, i + 1, 'html');
    const ms = Date.now() - started;
    console.log(
      `${plan.key.split('/').slice(3).join('/')}: ${result.ok ? result.outcome : result.code} in ${ms} ms`,
    );
    expect(result.ok).toBe(true);
    // The lane's own limit is 3 s per job; past it, the result is the fallback.
    expect(ms).toBeLessThan(5000);
  }
});

const MB = 1024 * 1024;

interface Memory {
  worker: { used: number; external: number; total: number; limit: number } | null;
  core: { rss: number; heapUsed: number; external: number; arrayBuffers: number };
}

async function memory(pev: PevApp): Promise<Memory> {
  return (await pev.main<{ data: Memory }>('core', 'reader-memory')).data;
}

/** The reader worker's live memory: its JS heap and the buffers outside it. */
const workerMemory = (m: Memory) => (m.worker ? m.worker.used + m.worker.external : 0);

/**
 * Opens `rowid` on a fresh reader worker and reports the time, the peak of the
 * worker's live memory, and how far core's resident memory (the worker's
 * included) rose above where it was, sampled while the job runs. Rowid 1
 * must be a small message: it starts the fresh worker before the measurement.
 */
async function measured(
  pev: PevApp,
  label: string,
  rowid: number,
  mode: OpenMode,
): Promise<{ result: MessageOpenResult; ms: number; workerPeak: number; rssGrowth: number }> {
  await pev.main('readerLimits', { heapMb: 512 });
  viewUrl(await openRow(pev, 1));
  const before = await memory(pev);
  let workerPeak = workerMemory(before);
  let rssPeak = before.core.rss;
  const started = Date.now();
  let done = false;
  const opening = openRow(pev, rowid, mode).finally(() => {
    done = true;
  });
  while (!done) {
    const now = await memory(pev);
    workerPeak = Math.max(workerPeak, workerMemory(now));
    rssPeak = Math.max(rssPeak, now.core.rss);
  }
  const result = await opening;
  const ms = Date.now() - started;
  const rssGrowth = rssPeak - before.core.rss;
  const outcome = !result.ok
    ? result.code
    : result.outcome === 'view'
      ? `${result.format}${result.htmlTooLarge ? ', HTML too large' : ''}${result.cut ? `, cut by ${result.cut}` : ''}`
      : 'fallback';
  console.log(
    `${label} (${mode}): ${outcome} in ${ms} ms; worker memory peak ${(workerPeak / MB).toFixed(0)} MB; core RSS +${(rssGrowth / MB).toFixed(0)} MB at peak`,
  );
  return { result, ms, workerPeak, rssGrowth };
}

function generated(kind: 'text' | 'html' | 'attachment', bytes: number): Entry {
  return { test: { kind: 'generated', spec: { kind, bytes, seed: 1 } } };
}

test('each reader ceiling: HTML too large, HTML anyway, the first 1 MB, and parts drained', async ({
  pev,
}) => {
  await source(pev, { 'plain.eml': PLAIN }, [
    [1, { file: 'plain.eml' }],
    [2, generated('html', 6 * MB)],
    [3, generated('html', 21 * MB)],
    [4, generated('text', 21 * MB)],
    [5, generated('attachment', 30 * MB)],
  ]);
  const bodyLength = async (result: MessageOpenResult) =>
    (await pev.main<{ status: number; length: number }>('fetchIn', 1, viewUrl(result))).length;

  // Over 5 MB: plain text, and HTML can be asked for anyway.
  const large = await measured(pev, 'HTML 6 MB', 2, 'html');
  expect(large.result).toMatchObject({
    outcome: 'view',
    format: 'plain',
    hasHtml: true,
    htmlTooLarge: true,
    cut: null,
  });
  const anyway = await measured(pev, 'HTML 6 MB', 2, 'html-anyway');
  expect(anyway.result).toMatchObject({ outcome: 'view', format: 'html', htmlTooLarge: false });

  // Over 20 MB: the first 1 MB of plain text only, for HTML and text bodies.
  for (const [rowid, label] of [
    [3, 'HTML 21 MB'],
    [4, 'Text 21 MB'],
  ] as const) {
    for (const mode of ['html', 'html-anyway', 'plain'] as const) {
      const cut = await measured(pev, label, rowid, mode);
      expect(cut.result).toMatchObject({
        outcome: 'view',
        format: 'plain',
        htmlTooLarge: false,
        cut: 'size',
      });
      const length = await bodyLength(cut.result);
      expect(length).toBeGreaterThan(0.9 * MB);
      expect(length).toBeLessThan(1.5 * MB);
      // At most 20 MB of the body is kept, and decoded once.
      expect(cut.workerPeak).toBeLessThan(256 * MB);
    }
  }

  // A large attachment is drained: the text part shows, whole.
  const drained = await measured(pev, 'Attachment 30 MB', 5, 'html');
  expect(drained.result).toMatchObject({
    outcome: 'view',
    format: 'plain',
    hasHtml: false,
    cut: null,
  });
  expect(drained.workerPeak).toBeLessThan(128 * MB);
});

test('"Show HTML anyway" near 20 MB ends in a view or the fallback, and plain text still opens', async ({
  pev,
}) => {
  // The generated part has 30 bytes of markup around its text: just under 20 MB.
  await source(pev, { 'plain.eml': PLAIN }, [
    [1, { file: 'plain.eml' }],
    [2, generated('html', 20 * MB - 64 * 1024)],
  ]);
  const offered = await measured(pev, 'HTML near 20 MB', 2, 'html');
  expect(offered.result).toMatchObject({ outcome: 'view', format: 'plain', htmlTooLarge: true });
  const anyway = await measured(pev, 'HTML near 20 MB', 2, 'html-anyway');
  expect(anyway.result.ok).toBe(true);
  if (anyway.result.ok && anyway.result.outcome === 'view') {
    expect(anyway.result.format).toBe('html');
  }
  // The lane's limit is 3 s per job; past it, the result is the fallback.
  expect(anyway.ms).toBeLessThan(5000);
  // A worker left holding that much is replaced after the job (or was ended by the limit).
  if (anyway.result.ok && anyway.result.outcome === 'view') {
    await expect.poll(() => pev.hasLog('reader.worker_retired', { proc: 'core' })).toBe(true);
  }
  const plain = await measured(pev, 'HTML near 20 MB', 2, 'plain');
  expect(plain.result).toMatchObject({ outcome: 'view', format: 'plain', cut: null });
  if (anyway.result.ok && anyway.result.outcome === 'view') {
    // Every worker here was ended on purpose (replaced, or for new limits): no exit is a warning.
    const exits = pev.logs('core').filter((l) => l.code === 'core.worker_exit');
    expect(exits.length).toBeGreaterThan(0);
    expect(exits.filter((l) => l.level !== 'info')).toEqual([]);
  }
});

test('a body too heavy to render as HTML gives the fallback, and its plain text still opens', async ({
  pev,
}) => {
  await source(pev, { 'plain.eml': PLAIN }, [
    [1, { file: 'plain.eml' }],
    [2, generated('html', 6 * MB)],
  ]);
  // Rendering this HTML needs well over this heap; its plain text needs less.
  await pev.main('readerLimits', { heapMb: 64 });
  expect(await openRow(pev, 2, 'html-anyway')).toMatchObject({
    ok: true,
    outcome: 'fallback',
    fileRefused: false,
  });
  expect(pev.hasLog('open.fallback', { reason: 'limit' })).toBe(true);
  // The fallback's action: the same message as plain text.
  expect(await openRow(pev, 2, 'plain')).toMatchObject({
    ok: true,
    outcome: 'view',
    format: 'plain',
    cut: null,
  });
});

test('the 200 MB text, HTML and attachment parts end in a view or the fallback', async ({
  pev,
}) => {
  await source(pev, { 'plain.eml': PLAIN }, [
    [1, { file: 'plain.eml' }],
    [2, generated('text', 200 * MB)],
    [3, generated('html', 200 * MB)],
    [4, generated('attachment', 200 * MB)],
  ]);
  for (const [rowid, label] of [
    [2, 'Text 200 MB'],
    [3, 'HTML 200 MB'],
    [4, 'Attachment 200 MB'],
  ] as const) {
    const opened = await measured(pev, label, rowid, 'html');
    expect(opened.result.ok).toBe(true);
    expect(opened.ms).toBeLessThan(5000);
    // Drained, not buffered: less than the part itself.
    expect(opened.workerPeak).toBeLessThan(192 * MB);
  }
});

test('a stale openId or generation installs no view', async ({ pev }) => {
  await source(pev, { 'plain.eml': PLAIN }, [
    [1, { file: 'plain.eml' }],
    // Found only once the older open's result has reached main, so main's own
    // check discards it. (When the newer one is found first, the reader lane
    // drops the older one; another test covers that.)
    [2, { file: 'plain.eml', gate: 'second' }],
  ]);
  const held = async () => (await pev.main<{ value: number }>('core', 'held')).value;

  await pev.main('core', 'hold');
  await startOpen(pev, 1, '__first');
  await startOpen(pev, 2, '__second');
  await expect.poll(held).toBe(2);
  await pev.main('core', 'release');
  expect(await finishOpen(pev, '__first')).toEqual({ ok: false, code: 'superseded' });
  expect(await gateWaiting(pev, 'second')).toBe(1);
  await pev.main('readerGate', 'second');
  const second = await finishOpen(pev, '__second');
  expect(await pev.main('liveViews', 1)).toBe(1);
  expect(await pev.main('authorizedUrl', 1)).toBe(viewUrl(second));
  expect(pev.hasLog('open.stale', { reason: 'open_id' })).toBe(true);

  await pev.main('core', 'hold');
  await startOpen(pev, 1, '__pending');
  await expect.poll(held).toBe(1);
  await pev.main('bumpGeneration');
  await pev.main('core', 'release');
  expect(await finishOpen(pev, '__pending')).toEqual({ ok: false, code: 'stale_generation' });
  expect(await pev.main('liveViews', 1)).toBe(0);
  expect(await pev.main('authorizedUrl', 1)).toBeNull();
  expect(pev.hasLog('open.stale', { reason: 'generation' })).toBe(true);
});

test('an older open whose lookup finishes last never drops the newer one', async ({ pev }) => {
  await source(pev, { 'plain.eml': PLAIN }, [
    // Keeps the worker busy (within the lane's 3 s) while the next two opens arrive.
    [1, { test: { kind: 'sleep', ms: 2500 } }],
    // Found only once the newer open below is queued.
    [2, { file: 'plain.eml', gate: 'older' }],
    [3, { file: 'plain.eml' }],
  ]);
  await startOpen(pev, 1, '__busy');
  await startOpen(pev, 2, '__older');
  // Main spaces a window's opens out: the older one is in core before the newer one starts.
  await expect.poll(() => gateWaiting(pev, 'older')).toBe(1);
  await startOpen(pev, 3, '__newer');
  await expect.poll(async () => (await laneInfo(pev)).queued).toBe(1);
  expect(await gateWaiting(pev, 'older')).toBe(1);
  await pev.main('readerGate', 'older');
  expect(await finishOpen(pev, '__older')).toEqual({ ok: false, code: 'superseded' });
  expect(await finishOpen(pev, '__busy')).toEqual({ ok: false, code: 'superseded' });
  const newer = await finishOpen(pev, '__newer');
  expect(await pev.main('liveViews', 1)).toBe(1);
  expect(await pev.main('authorizedUrl', 1)).toBe(viewUrl(newer));
});

test('a timeout and a heap breach each end the worker and give the fallback; the next open works', async ({
  pev,
}) => {
  await source(pev, { 'plain.eml': PLAIN }, [
    [1, { file: 'plain.eml' }],
    [2, { test: { kind: 'spin' } }],
    [3, { test: { kind: 'heap' } }],
  ]);
  viewUrl(await openRow(pev, 1));
  const first = await laneInfo(pev);
  expect(first.heapMb).toBe(512);

  // A job that never yields: ended at the lane's 3 s limit.
  const started = Date.now();
  const spun = await openRow(pev, 2);
  expect(Date.now() - started).toBeGreaterThanOrEqual(2900);
  expect(spun).toMatchObject({ ok: true, outcome: 'fallback' });
  expect(pev.hasLog('reader.timeout', { proc: 'core' })).toBe(true);
  expect(pev.hasLog('open.fallback', { reason: 'timeout' })).toBe(true);
  viewUrl(await openRow(pev, 1));
  const afterTimeout = await laneInfo(pev);
  expect(afterTimeout.threadId).not.toBe(first.threadId);
  expect(afterTimeout.heapMb).toBe(512);

  // A job that allocates without end: ended by the heap limit. A smaller
  // limit keeps the test short; the path is the same.
  await pev.main('readerLimits', { heapMb: 64 });
  const heap = await openRow(pev, 3);
  expect(heap).toMatchObject({ ok: true, outcome: 'fallback' });
  expect(pev.hasLog('reader.limit', { proc: 'core' })).toBe(true);
  expect(pev.hasLog('open.fallback', { reason: 'limit' })).toBe(true);
  viewUrl(await openRow(pev, 1));
  const afterLimit = await laneInfo(pev);
  expect(afterLimit.threadId).not.toBe(afterTimeout.threadId);
  expect(afterLimit.heapMb).toBe(64);
});

test('every malformed-MIME and odd-charset message gives a body or the fallback', async ({
  pev,
}) => {
  const { plans } = hostileMessages({
    seed: 1,
    nonce: randomBytes(6).toString('hex'),
    labelInfo: { file: { Payload: [] } },
    owner: { Name: 'Owner', Address: 'owner@example.com' },
  });
  const chosen = plans.filter((p) =>
    ['malformed_mime', 'odd_charsets'].includes(p.key.split('/')[3] ?? ''),
  );
  expect(chosen.length).toBeGreaterThan(10);
  const files: Record<string, Buffer> = {};
  const entries: Array<[number, Entry]> = [];
  chosen.forEach((plan, i) => {
    files[`m${i}.eml`] = plan.emlData;
    entries.push([i + 1, { file: `m${i}.eml` }]);
  });
  await source(pev, files, entries);

  const outcomes: Record<string, string> = {};
  for (const [i, plan] of chosen.entries()) {
    const result = await openRow(pev, i + 1);
    const name = plan.key.split('/').slice(3).join('/');
    expect(result.ok, name).toBe(true);
    if (!result.ok) continue;
    outcomes[name] = result.outcome;
    if (result.outcome === 'view') {
      const body = await pev.main<{ status: number }>('fetchIn', 1, result.url);
      expect(body.status, name).toBe(200);
    }
  }
  expect(Object.keys(outcomes)).toHaveLength(chosen.length);
  console.log('reader outcomes:', JSON.stringify(outcomes));
});

test('opens without a source, of an unknown rowid or a refused file, or with bad arguments, fail', async ({
  pev,
}) => {
  expect(await openRow(pev, 1)).toEqual({ ok: false, code: 'no_source' });

  await source(
    pev,
    { 'plain.eml': PLAIN },
    [
      [1, { file: 'plain.eml' }],
      [2, { file: 'link.eml' }],
      [3, { file: '../plain.eml' }],
    ],
    [['link.eml', 'plain.eml']],
  );
  expect(await openRow(pev, 2)).toEqual({ ok: false, code: 'not_found' });
  expect(await openRow(pev, 3)).toEqual({ ok: false, code: 'not_found' });
  expect(await openRow(pev, 9)).toEqual({ ok: false, code: 'not_found' });

  // The source's folder is fixed once set.
  const other = testDir('reader-other');
  const moved = await pev.main<{ ok: boolean }>('readerSource', other, []);
  expect(moved.ok).toBe(false);
  viewUrl(await openRow(pev, 1));

  const generation = await pev.main<number>('generation');
  const bad: unknown[][] = [
    [{ rowid: 0, mode: 'plain', generation }],
    [{ rowid: -1, mode: 'plain', generation }],
    [{ rowid: 1.5, mode: 'plain', generation }],
    [{ rowid: '1', mode: 'plain', generation }],
    [{ rowid: 2 ** 53, mode: 'plain', generation }],
    [{ rowid: 1, mode: 'source', generation }],
    [{ rowid: 1, generation }],
    [{ rowid: 1, mode: 'plain', generation, path: '/etc/hosts' }],
    [{ rowid: 1, mode: 'plain', generation }, 'extra'],
    [],
  ];
  for (const args of bad) {
    const result = await pev.page.evaluate(
      (a) => window.__pevTestIpc.invoke('pev:open', ...a),
      args,
    );
    expect(result, JSON.stringify(args)).toEqual({ ok: false, code: 'invalid' });
  }
  expect(
    await pev.page.evaluate(
      (g) => window.__pevTestIpc.invoke('pev:open', { rowid: 1, mode: 'plain', generation: g + 1 }),
      generation,
    ),
  ).toEqual({ ok: false, code: 'stale_generation' });
});
