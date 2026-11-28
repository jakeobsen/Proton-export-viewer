// SPDX-License-Identifier: AGPL-3.0-or-later
// Inline images end to end, in the reader pane's body frame, on the hostile
// corpus's inline-image messages: every image the raster check refuses, as a
// cid: part and as a data: image, shows the placeholder and logs its reason;
// the valid ones render, checked by their pixels in a capture of the hidden
// window; each alternative shows its own image; a revoked view's images are
// gone; and nothing is requested outside the view's own URLs.

import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Frame } from '@playwright/test';
import type { MessageOpenResult } from '../../src/shared/api';
import {
  INLINE_BOMBS,
  INLINE_COLORS,
  hostileMessages,
  type HostilePlan,
} from '../../tools/gen-export/hostile.mjs';
import { gifImage } from '../../tools/gen-export/images.mjs';
import { MARKERS, MARKER_TEXT, findMarkers } from '../markers';
import { testDir } from '../paths';
import { middlePixel, type Rgb } from '../png-pixels';
import { expect, test, tokenOf, type PevApp } from './app';

interface Requests {
  app: string[];
  body: string[];
  asset: string[];
  blocked: string[];
  sessionPreconnects: string[];
}

const NONCE = randomBytes(6).toString('hex');

/** The inline-image messages, by name. */
function corpus(): Map<string, HostilePlan> {
  const plans = hostileMessages({
    seed: 1,
    nonce: NONCE,
    labelInfo: { file: { Payload: [] } },
    owner: { Name: 'Owner', Address: 'owner@example.com' },
  }).plans.filter((p) => p.key.includes('/inline_images/'));
  return new Map(plans.map((p) => [p.key.split('/').at(-1) ?? '', p]));
}

/** Writes the messages under a new test folder; returns each one's rowid by name. */
async function source(pev: PevApp, plans: Map<string, HostilePlan>): Promise<Map<string, number>> {
  const root = testDir('inline-images-root');
  const rows = new Map<string, number>();
  const entries = [...plans.entries()].map(([name, plan], i) => {
    writeFileSync(join(root, `m${i}.eml`), plan.emlData);
    rows.set(name, i + 1);
    return [i + 1, { file: `m${i}.eml` }] as const;
  });
  const result = await pev.main<{ ok: boolean }>('readerSource', root, entries);
  expect(result.ok).toBe(true);
  return rows;
}

/** The view of a message in the reader pane's body frame. */
async function view(
  pev: PevApp,
  rowid: number,
): Promise<{ opened: MessageOpenResult & { url: string }; frame: Frame }> {
  await pev.main('clearRequests');
  const { result, frame } = await pev.showInPane(rowid, 'html');
  return { opened: result, frame };
}

/** How wide an image in the body came out once loaded, or -1 while it loads. */
function naturalWidth(frame: Frame, id: string): Promise<number> {
  return frame.evaluate((i) => {
    const img = document.getElementById(i) as HTMLImageElement | null;
    return img?.complete ? img.naturalWidth : -1;
  }, id);
}

/** The colour in the middle of an image, from a capture of the window. */
async function colorOf(frame: Frame, id: string): Promise<Rgb> {
  await expect.poll(() => naturalWidth(frame, id)).toBe(40);
  return middlePixel(await frame.locator(`#${id}`).screenshot());
}

function near(actual: Rgb, expected: readonly number[]): boolean {
  return actual.every((c, i) => Math.abs(c - (expected[i] ?? -1)) <= 3);
}

/** Fails, naming both colours, unless each channel of `actual` is within 3 of `expected`. */
function expectNear(actual: Rgb, expected: readonly number[], label: string): void {
  expect(
    near(actual, expected),
    `${label}: got ${actual.join(',')}, expected ${expected.join(',')}`,
  ).toBe(true);
}

/** The reasons logged for refused inline images so far, one per log line. */
function refusals(pev: PevApp): string[] {
  return pev
    .logs()
    .filter((l) => l.code === 'reader.images_refused')
    .map((l) => `${String(l.data.reason)}:${String(l.data.count)}`);
}

/** Only this view's own requests, and nothing stopped. */
async function ownRequestsOnly(pev: PevApp, opened: { url: string }): Promise<void> {
  const token = tokenOf(opened.url);
  const seen = await pev.main<Requests>('requests', 1);
  expect(seen.blocked).toEqual([]);
  expect(seen.sessionPreconnects).toEqual([]);
  expect(seen.body.filter((u) => u !== opened.url)).toEqual([]);
  expect(seen.asset.filter((u) => !u.startsWith(`mail-asset://v/${token}/`))).toEqual([]);
  expect(seen.app.filter((u) => !u.startsWith('app://shell/'))).toEqual([]);
}

test('every refused inline image shows the placeholder and logs its reason, as cid: and as data: @pane', async ({
  pev,
}) => {
  test.setTimeout(240_000);
  const plans = corpus();
  const rows = await source(pev, plans);
  const names = Object.keys(INLINE_BOMBS).flatMap((n) => [`cid-${n}`, `data-${n}`]);
  expect(names.length).toBe(2 * Object.keys(INLINE_BOMBS).length);
  for (const name of names) {
    const reason = INLINE_BOMBS[name.replace(/^(cid|data)-/, '')]?.[1];
    const before = refusals(pev).length;
    const { opened, frame } = await view(pev, rows.get(name) as number);
    expect([name, opened.ok && opened.outcome === 'view' && opened.format]).toEqual([name, 'html']);
    await expect.poll(() => refusals(pev).length, { timeout: 5_000 }).toBe(before + 1);
    expect([name, refusals(pev).at(-1)]).toEqual([name, `${reason}:1`]);
    await expect.poll(() => naturalWidth(frame, 'bomb')).toBe(1);
    await ownRequestsOnly(pev, opened);
  }
});

test('a valid cid: PNG and a valid data: GIF render, pixel-checked, with the detected type @pane', async ({
  pev,
}) => {
  const rows = await source(pev, corpus());
  const cid = await view(pev, rows.get('cid-valid') as number);
  expectNear(await colorOf(cid.frame, 'inline'), INLINE_COLORS.cid, 'cid');
  const asset = await pev.main<{ status: number; headers: Record<string, string> }>(
    'fetchIn',
    1,
    `mail-asset://v/${tokenOf(cid.opened.url)}/c1`,
  );
  expect(asset.status).toBe(200);
  expect(asset.headers['content-type']).toBe('image/png');
  await ownRequestsOnly(pev, cid.opened);

  const data = await view(pev, rows.get('data-valid') as number);
  expectNear(await colorOf(data.frame, 'inline'), INLINE_COLORS.data, 'data');
  await ownRequestsOnly(pev, data.opened);
});

test('each alternative shows its own image for a shared Content-ID, with and without related parts @pane', async ({
  pev,
}) => {
  const rows = await source(pev, corpus());
  for (const name of ['scope-related', 'scope-mixed']) {
    const { frame } = await view(pev, rows.get(name) as number);
    expectNear(await colorOf(frame, 'first'), INLINE_COLORS.first, `${name} first`);
    expectNear(await colorOf(frame, 'second'), INLINE_COLORS.second, `${name} second`);
  }
  for (const [name, id] of [
    ['scope-duplicate', 'duplicate'],
    ['scope-escape', 'escape'],
  ] as const) {
    const { frame } = await view(pev, rows.get(name) as number);
    await expect.poll(() => naturalWidth(frame, id)).toBe(1);
  }
});

test('a data: image stays only in <img src> @pane', async ({ pev }) => {
  const rows = await source(pev, corpus());
  const { frame, opened } = await view(pev, rows.get('data-places') as number);
  const places = await frame.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll('*')) {
      for (const a of el.attributes)
        if (/data:/i.test(a.value)) out.push(`${el.localName} ${a.name}`);
      if (el.localName === 'style' && /data:/i.test(el.textContent ?? '')) out.push('style sheet');
    }
    return out;
  });
  expect(places).toEqual(['img src']);
  await ownRequestsOnly(pev, opened);
});

test("a revoked view's inline images are gone @pane", async ({ pev }) => {
  const rows = await source(pev, corpus());
  const first = await view(pev, rows.get('cid-valid') as number);
  const url = `mail-asset://v/${tokenOf(first.opened.url)}/c1`;
  expect((await pev.main<{ status: number }>('fetchIn', 1, url)).status).toBe(200);
  await view(pev, rows.get('data-valid') as number);
  expect((await pev.main<{ status: number }>('fetchIn', 1, url)).status).toBe(404);
  expect(pev.hasLog('protocol.not_found', { scheme: 'mail-asset', reason: 'unknown_token' })).toBe(
    true,
  );
});

test('no Content-ID, file name or data: URL of a refused image reaches a log @pane', async ({
  pev,
}) => {
  const [id0 = '', id1 = '', id2 = '', name = ''] = MARKERS;
  const cid = (id: string) => `cid:${encodeURIComponent(id)}`;
  const bomb = gifImage(1, 1, 1001).toString('base64');
  const image = (id: string, extra: string[] = []) => [
    '--r',
    'Content-Type: image/gif',
    `Content-ID: <${id}>`,
    ...extra,
    'Content-Transfer-Encoding: base64',
    '',
    bomb,
  ];
  const eml = [
    'Subject: inline images',
    'MIME-Version: 1.0',
    'Content-Type: multipart/related; boundary="r"',
    '',
    '--r',
    'Content-Type: text/html; charset=utf-8',
    '',
    `<html><body><img src="${cid(id0)}"><img src="${cid(id1)}"><img src="${cid(id2)}">`,
    `<img src="data:image/png,${encodeURIComponent(MARKER_TEXT)}"></body></html>`,
    // Refused by the raster check, with a marker file name.
    ...image(id0, [`Content-Disposition: inline; filename="${name}"`]),
    // Two parts with one ID: neither shows.
    ...image(id2),
    ...image(id2),
    '--r--',
    '',
  ].join('\r\n');
  const root = testDir('inline-redaction');
  writeFileSync(join(root, 'markers.eml'), eml);
  expect(
    (await pev.main<{ ok: boolean }>('readerSource', root, [[1, { file: 'markers.eml' }]])).ok,
  ).toBe(true);
  await view(pev, 1);
  // Each refusal path logged: the raster check, a missing and an ambiguous ID, a data: URL.
  for (const reason of ['frames', 'missing', 'ambiguous', 'format']) {
    await expect
      .poll(() => pev.hasLog('reader.images_refused', { proc: 'worker', reason }), {
        message: reason,
      })
      .toBe(true);
  }
  // Also as matched (lower case) and as written in a cid: URL (percent-encoded).
  const more = MARKERS.flatMap((m) => [m.toLowerCase(), encodeURIComponent(m), cid(m).slice(4)]);
  const dir = pev.logsDir();
  for (const file of readdirSync(dir)) {
    const text = readFileSync(join(dir, file), 'utf8');
    expect(findMarkers(text), file).toEqual([]);
    expect(
      more.filter((m) => text.toLowerCase().includes(m.toLowerCase())),
      file,
    ).toEqual([]);
  }
});
