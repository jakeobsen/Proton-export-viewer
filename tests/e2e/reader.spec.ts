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
import type { TestInput } from '../../src/shared/reader-protocol';
import { hostileMessages } from '../../tools/gen-export/hostile.mjs';
import { testDir } from '../paths';
import { expect, test, tokenOf, type PevApp } from './app';

type Entry = ({ file: string } | { test: TestInput }) & { delayMs?: number };

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
  mode: 'plain' | 'html' = 'plain',
  page: Page = pev.page,
): Promise<MessageOpenResult> {
  return page.evaluate(
    async ([r, m]) => {
      const state = await window.pev.state();
      if (!state.ok) return state;
      return window.pev.open(r as number, m as 'plain' | 'html', state.generation);
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
  const result = await pev.main<{ data: { threadId: number | null; heapMb: number | null } }>(
    'core',
    'reader-lane',
  );
  return result.data;
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

  // A click on a link opens nothing and navigates nowhere.
  await frame.evaluate(() => (document.querySelector('a') as HTMLAnchorElement).click());
  await expect
    .poll(() => pev.hasLog('nav.window_open_denied', { scheme: 'mail-asset' }))
    .toBe(true);
  expect(pev.app.windows()).toHaveLength(1);
  expect(frame.url()).toBe(secondUrl);
  expect(await pev.main('linkDialogs')).toEqual([]);
});

test('a stale openId or generation installs no view', async ({ pev }) => {
  await source(pev, { 'plain.eml': PLAIN }, [
    [1, { file: 'plain.eml' }],
    [2, { file: 'plain.eml' }],
  ]);
  const held = async () => (await pev.main<{ value: number }>('core', 'held')).value;

  await pev.main('core', 'hold');
  await startOpen(pev, 1, '__first');
  await startOpen(pev, 2, '__second');
  await expect.poll(held).toBe(2);
  await pev.main('core', 'release');
  expect(await finishOpen(pev, '__first')).toEqual({ ok: false, code: 'superseded' });
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
    // Keeps the worker busy while the next two opens arrive.
    [1, { test: { kind: 'sleep', ms: 1500 } }],
    // Found only after the newer open below is already queued.
    [2, { file: 'plain.eml', delayMs: 600 }],
    [3, { file: 'plain.eml' }],
  ]);
  await startOpen(pev, 1, '__busy');
  await startOpen(pev, 2, '__older');
  await startOpen(pev, 3, '__newer');
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
