// SPDX-License-Identifier: AGPL-3.0-or-later
// The reader pane: one message with its header fields, the plain text and
// HTML switch, the lines for blocked images, size limits and the fallback,
// and a frame that goes blank as soon as the next open starts.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MessageOpenResult } from '../../src/shared/api';
import type { OpenMode, TestInput } from '../../src/shared/reader-protocol';
import { MAX_MIME_PARTS } from '../../src/core/mime-limits';
import { bodiesAfter, bodiesAround } from '../mime-parts';
import { testDir } from '../paths';
import { expect, test, tokenOf, type PevApp } from './app';

type Entry = ({ file: string } | { test: TestInput }) & { gate?: string };

const MB = 1024 * 1024;

const HTML = [
  'Subject: Your November picks',
  'From: "Ana Lee" <ana@example.org>',
  'To: <owner@example.com>',
  'Cc: <cc@example.com>',
  'Date: Wed, 25 Nov 2026 08:02:11 +0100',
  'Content-Type: multipart/alternative; boundary="alt"',
  '',
  '--alt',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Hello in plain text.',
  '--alt',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p id="p">Hello in HTML.</p>',
  '<img src="https://images.example.org/a.png"><img src="https://images.example.org/b.png">',
  '--alt--',
  '',
].join('\r\n');

const PLAIN = [
  'Subject: Plain only',
  'From: <sender@example.org>',
  'To: <owner@example.com>',
  'Date: Mon, 1 Jan 2024 10:00:00 +0000',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Just text.',
  '',
].join('\r\n');

const LINK = [
  'Subject: A link',
  'From: <sender@example.org>',
  'To: <owner@example.com>',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p><a href="https://shop.example/">shop.example</a></p>',
  '',
].join('\r\n');

function generated(kind: 'text' | 'html', bytes: number): Entry {
  return { test: { kind: 'generated', spec: { kind, bytes, seed: 1 } } };
}

async function source(pev: PevApp, entries: Array<[number, Entry]>): Promise<void> {
  const root = testDir('pane-root');
  writeFileSync(join(root, 'html.eml'), HTML);
  writeFileSync(join(root, 'plain.eml'), PLAIN);
  writeFileSync(join(root, 'link.eml'), LINK);
  const result = await pev.main<{ ok: boolean }>('readerSource', root, entries);
  expect(result.ok).toBe(true);
}

function openInReader(pev: PevApp, rowid: number, mode?: OpenMode): Promise<MessageOpenResult> {
  return pev.shell<MessageOpenResult>('openInReader', mode ? [rowid, mode] : [rowid]);
}

/** Waits until the pane's frame shows the latest view, and returns its URL. */
async function shownUrl(pev: PevApp): Promise<string> {
  await expect
    .poll(async () => {
      const r = await pev.shell<{ pending: boolean; view: { url: string } | null }>('reader');
      const src = await pev.page.locator('.rp-frame').getAttribute('src');
      return !r.pending && r.view !== null && src === r.view.url;
    })
    .toBe(true);
  const url = (await pev.page.locator('.rp-frame').getAttribute('src')) as string;
  await pev.bodyFrame(url);
  return url;
}

async function status(pev: PevApp, url: string): Promise<number> {
  return (await pev.main<{ status: number }>('fetchIn', 1, url)).status;
}

const pane = (pev: PevApp) => pev.page.locator('.rp');

test('a message opens in the pane as HTML first, with its header fields', async ({ pev }) => {
  await source(pev, [[1, { file: 'html.eml' }]]);
  await openInReader(pev, 1);
  const url = await shownUrl(pev);
  await expect(pane(pev).locator('.rp-subject')).toHaveText('Your November picks');
  await expect(pane(pev).locator('.rp-name')).toHaveText('Ana Lee');
  await expect(pane(pev).locator('.rp-avatar')).toHaveText('AL');
  await expect(pane(pev).locator('.rp-date')).not.toHaveText('');
  await expect(pane(pev).locator('.rp-addr')).toHaveText('<ana@example.org>');
  await expect(pane(pev).locator('.rp-to')).toHaveText('to owner@example.com, cc@example.com');
  await expect(pane(pev).locator('.rp-html')).toHaveAttribute('aria-pressed', 'true');
  await expect(pane(pev).locator('.rp-plain')).toHaveAttribute('aria-pressed', 'false');
  await expect(pane(pev).locator('.rp-images')).toHaveText('2 external images blocked');
  const frame = await pev.bodyFrame(url);
  expect(await frame.locator('#p').textContent()).toBe('Hello in HTML.');

  // Details: the full fields, and back.
  await pane(pev).locator('.rp-linkish').click();
  await expect(pane(pev).locator('.rp-details dt')).toHaveText([
    'From',
    'To',
    'Cc',
    'Date',
    'Format',
  ]);
  await expect(pane(pev).locator('.rp-details dd').first()).toHaveText(
    '"Ana Lee" <ana@example.org>',
  );
  await expect(pane(pev).locator('.rp-linkish')).toHaveText('Hide details');
  await pane(pev).locator('.rp-linkish').click();
  await expect(pane(pev).locator('.rp-details')).toHaveCount(0);

  // Labels, actions, data and real warnings only.
  expect(await pane(pev).locator('button').allTextContents()).toEqual([
    'Plain text',
    'HTML',
    'Save .eml',
    'Show in folder',
    'Message-ID',
    'Details',
  ]);
  expect(await pane(pev).locator('.rp-line').allTextContents()).toEqual([
    '2 external images blocked',
  ]);
});

test('the switch is a new open with its own token, and revokes the old one', async ({ pev }) => {
  await source(pev, [[1, { file: 'html.eml' }]]);
  await openInReader(pev, 1);
  const html = await shownUrl(pev);

  await pane(pev).locator('.rp-plain').click();
  const plain = await shownUrl(pev);
  expect(tokenOf(plain)).not.toBe(tokenOf(html));
  expect(await status(pev, html)).toBe(404);
  expect(await pev.main('authorizedUrl', 1)).toBe(plain);
  await expect(pane(pev).locator('.rp-plain')).toHaveAttribute('aria-pressed', 'true');
  await expect(pane(pev).locator('.rp-images')).toHaveCount(0);
  const frame = await pev.bodyFrame(plain);
  expect(await frame.locator('pre').textContent()).toBe('Hello in plain text.');

  await pane(pev).locator('.rp-html').click();
  const again = await shownUrl(pev);
  expect(new Set([tokenOf(html), tokenOf(plain), tokenOf(again)]).size).toBe(3);
  expect(await status(pev, plain)).toBe(404);
  expect(await pev.main('liveViews', 1)).toBe(1);
});

test('a message without HTML has the HTML switch off', async ({ pev }) => {
  await source(pev, [[2, { file: 'plain.eml' }]]);
  await openInReader(pev, 2);
  await shownUrl(pev);
  await expect(pane(pev).locator('.rp-plain')).toHaveAttribute('aria-pressed', 'true');
  await expect(pane(pev).locator('.rp-html')).toBeDisabled();
  await expect(pane(pev).locator('.rp-html')).toHaveAttribute('title', 'No HTML version');
  await expect(pane(pev).locator('.rp-to')).toHaveText('to owner@example.com');
  await expect(pane(pev).locator('.rp-line')).toHaveCount(0);

  // Opened as plain text, it still has no HTML to switch to.
  await openInReader(pev, 2, 'plain');
  await shownUrl(pev);
  await expect(pane(pev).locator('.rp-plain')).toHaveAttribute('aria-pressed', 'true');
  await expect(pane(pev).locator('.rp-html')).toBeDisabled();
});

test('HTML over 5 MB opens as plain text, and "Show HTML anyway" opens it as HTML', async ({
  pev,
}) => {
  await source(pev, [[3, generated('html', 6 * MB)]]);
  await openInReader(pev, 3);
  const plain = await shownUrl(pev);
  await expect(pane(pev).locator('.rp-plain')).toHaveAttribute('aria-pressed', 'true');
  await expect(pane(pev).locator('.rp-html')).toBeDisabled();
  await expect(pane(pev).locator('.rp-too-large button')).toHaveText('Show HTML anyway');

  await pane(pev).locator('.rp-too-large button').click();
  const html = await shownUrl(pev);
  expect(tokenOf(html)).not.toBe(tokenOf(plain));
  expect(await status(pev, plain)).toBe(404);
  await expect(pane(pev).locator('.rp-html')).toHaveAttribute('aria-pressed', 'true');
  await expect(pane(pev).locator('.rp-too-large')).toHaveCount(0);
});

test('over 20 MB the pane says only the first 1 MB is shown', async ({ pev }) => {
  await source(pev, [
    [4, generated('text', 21 * MB)],
    [5, generated('html', 21 * MB)],
  ]);
  await openInReader(pev, 4);
  await shownUrl(pev);
  await expect(pane(pev).locator('.rp-truncated')).toHaveText('First 1 MB shown');

  // HTML over 20 MB: plain text only, with neither the HTML switch nor "Show HTML anyway".
  await openInReader(pev, 5);
  await shownUrl(pev);
  await expect(pane(pev).locator('.rp-truncated')).toHaveText('First 1 MB shown');
  await expect(pane(pev).locator('.rp-plain')).toHaveAttribute('aria-pressed', 'true');
  await expect(pane(pev).locator('.rp-html')).toBeDisabled();
  await expect(pane(pev).locator('.rp-too-large')).toHaveCount(0);
});

test('many parts: bodies after 1,000 show whole; past the part limit only part shows', async ({
  pev,
}) => {
  const root = testDir('pane-parts');
  writeFileSync(join(root, 'after.eml'), bodiesAfter(1001));
  writeFileSync(join(root, 'around.eml'), bodiesAround(MAX_MIME_PARTS + 10));
  const result = await pev.main<{ ok: boolean }>('readerSource', root, [
    [1, { file: 'after.eml' }],
    [2, { file: 'around.eml' }],
  ]);
  expect(result.ok).toBe(true);

  // The bodies after the 1,000th part, whole, in both views.
  await openInReader(pev, 1, 'html');
  let frame = await pev.bodyFrame(await shownUrl(pev));
  expect(await frame.locator('#p').textContent()).toBe('HTML after the parts.');
  await expect(pane(pev).locator('.rp-truncated')).toHaveCount(0);
  await openInReader(pev, 1, 'plain');
  frame = await pev.bodyFrame(await shownUrl(pev));
  expect(await frame.locator('pre').textContent()).toContain('Text after the parts.');
  await expect(pane(pev).locator('.rp-truncated')).toHaveCount(0);

  // Past the part limit: what came before it, with the line, in both views.
  await openInReader(pev, 2, 'html');
  frame = await pev.bodyFrame(await shownUrl(pev));
  expect(await frame.locator('#p').textContent()).toBe('HTML before the parts.');
  expect(await frame.locator('body').textContent()).not.toContain('after the parts');
  await expect(pane(pev).locator('.rp-truncated')).toHaveText('Only part of this message shown');
  await openInReader(pev, 2, 'plain');
  frame = await pev.bodyFrame(await shownUrl(pev));
  const text = await frame.locator('pre').textContent();
  expect(text).toContain('Text before the parts.');
  expect(text).not.toContain('after the parts');
  await expect(pane(pev).locator('.rp-truncated')).toHaveText('Only part of this message shown');
  // Each read that stopped at the limit left core's file open for core to close, once.
  expect(pev.hasLog('core.rejection')).toBe(false);
  expect(pev.hasLog('core.uncaught')).toBe(false);
});

test('the fallback offers the message as plain text', async ({ pev }) => {
  await source(pev, [[3, generated('html', 6 * MB)]]);
  // Rendering this HTML needs well over this heap; its plain text needs less.
  await pev.main('readerLimits', { heapMb: 64 });
  await openInReader(pev, 3, 'html-anyway');
  await expect(pane(pev).locator('.rp-fallback')).toContainText("Couldn't render this message");
  await expect(pane(pev).locator('.rp-fallback button')).toHaveText('View as plain text');
  await expect(pane(pev).locator('.rp-frame')).toHaveCount(0);

  await pane(pev).locator('.rp-fallback button').click();
  await shownUrl(pev);
  await expect(pane(pev).locator('.rp-fallback')).toHaveCount(0);
  await expect(pane(pev).locator('.rp-plain')).toHaveAttribute('aria-pressed', 'true');
});

test('the old frame goes blank as soon as the next open starts', async ({ pev }) => {
  await source(pev, [
    [1, { file: 'html.eml' }],
    [2, { file: 'plain.eml', gate: 'next' }],
  ]);
  await openInReader(pev, 1);
  const first = await shownUrl(pev);

  // The next open waits at the source's gate, before any parse.
  await pev.page.evaluate(() => {
    const api = (window as unknown as { __pevTest: { openInReader(r: number): unknown } })
      .__pevTest;
    void api.openInReader(2);
  });
  await expect
    .poll(async () => (await pev.main<{ value: number }>('readerGateWaiting', 'next')).value)
    .toBe(1);
  await expect(pane(pev).locator('.rp-frame')).toHaveCount(0);
  expect(await status(pev, first)).toBe(404);
  expect(pev.page.frames().some((f) => f.url() === first)).toBe(false);

  await pev.main('readerGate', 'next');
  const second = await shownUrl(pev);
  expect(tokenOf(second)).not.toBe(tokenOf(first));
  await expect(pane(pev).locator('.rp-subject')).toHaveText('Plain only');
});

/** Relative luminance of a computed `rgb()` or `rgba()` colour. */
function luminance(color: string): number {
  const [r, g, b] = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map((v) => {
    const c = Number(v) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

test('plain text stays readable in the light and the dark scheme', async ({ pev }) => {
  await source(pev, [[2, { file: 'plain.eml' }]]);
  for (const colorScheme of ['light', 'dark'] as const) {
    await pev.page.emulateMedia({ colorScheme });
    await openInReader(pev, 2);
    const frame = await pev.bodyFrame(await shownUrl(pev));
    const text = await frame.locator('pre').evaluate((el) => getComputedStyle(el).color);
    const behind = await pane(pev)
      .locator('.rp-frame')
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(Math.abs(luminance(text) - luminance(behind)), colorScheme).toBeGreaterThan(0.5);
  }
});

test('a generation change that main pushes closes the pane and its link dialog', async ({
  pev,
}) => {
  await source(pev, [[3, { file: 'link.eml' }]]);
  await openInReader(pev, 3);
  const url = await shownUrl(pev);
  await pev.shell('windowOpen', [`mail-asset://v/${tokenOf(url)}/l1`]);
  await expect(pev.page.locator('.link-dialog')).toHaveCount(1);

  // Main moves on by itself, as after a restore or a rebuild, and tells the shell.
  await pev.main('bumpGeneration');
  await pev.main('notifySources');
  await expect(pane(pev)).toHaveCount(0);
  await expect(pev.page.locator('.link-dialog')).toHaveCount(0);
  expect(await status(pev, url)).toBe(404);
});
