// SPDX-License-Identifier: AGPL-3.0-or-later
// The reader's attachment list, Details and the message actions: what the
// list shows in each mode, the mark on a program file, a long list made
// virtual, the Details values, and Show in folder and Copy Message-ID, which
// the test build records instead of calling the system.

import { readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { MessageOpenResult, ReaderActionResult } from '../../src/shared/api';
import type { IndexProgress, IndexTotals } from '../../src/shared/index-types';
import type { OpenMode } from '../../src/shared/reader-protocol';
import { MAX_REFERENCES } from '../../src/shared/reader-protocol';
import type { Stamp } from '../../src/shared/sources';
import { MAX_MIME_PARTS } from '../../src/core/mime-limits';
import { samplePng } from '../../src/core/png';
import { fileSize } from '../../src/renderer/reader-format';
import { writeExport } from '../exports';
import { testDir } from '../paths';
import { expect, test, type PevApp } from './app';

interface ExternalCall {
  method: string;
  args: string[];
}

const crlf = (lines: string[]) => lines.join('\r\n');
const PNG = Buffer.from(samplePng());
const REFS = Array.from({ length: MAX_REFERENCES + 3 }, (_, i) => `<r${i}@example.org>`);

/** An HTML body that shows one cid image, and four other attachments, one of them a program. */
const MIXED = crlf([
  'Subject: Mixed',
  'From: "Ana Lee" <ana@example.org>',
  'To: <owner@example.com>',
  'Date: Wed, 25 Nov 2026 08:02:11 +0100',
  // A right-to-left override inside the ID: Details and the copy show it without.
  'Message-ID: <a‮moc.elpmaxe@1>',
  `References: ${REFS.join(' ')}`,
  'Content-Type: multipart/mixed; boundary="m"',
  '',
  '--m',
  'Content-Type: multipart/related; boundary="r"',
  '',
  '--r',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p id="p">Hi</p><img src="cid:logo@x">',
  '--r',
  'Content-Type: image/png',
  'Content-ID: <logo@x>',
  'Content-Disposition: inline; filename="logo.png"',
  'Content-Transfer-Encoding: base64',
  '',
  PNG.toString('base64'),
  '--r--',
  '--m',
  'Content-Type: application/pdf; name="report.pdf"',
  'Content-Disposition: attachment; filename="report.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  // Stray characters the decoder skips: "hello world!!!!", 15 decoded bytes.
  'aGVsbG8g*d29y!bGQh',
  'ISEh',
  '--m',
  'Content-Type: text/plain; name="notes.txt"',
  'Content-Disposition: inline; filename="notes.txt"',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'caf=C3=A9 =',
  'au lait',
  '--m',
  'Content-Type: application/octet-stream',
  'Content-Disposition: attachment',
  '',
  'raw',
  '--m',
  'Content-Type: application/x-msdownload; name="setup.exe"',
  'Content-Disposition: attachment; filename="setup.exe"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('MZ program').toString('base64'),
  '--m--',
  '',
]);

/**
 * A plain message with `count` small attachments and no Message-ID; every
 * `riskyEvery`th one, from the first, is a program file.
 */
function many(count: number, digits = 3, riskyEvery = 0): string {
  const ext = (i: number) => (riskyEvery > 0 && i % riskyEvery === 0 ? 'exe' : 'txt');
  const parts = Array.from({ length: count }, (_, i) => [
    '--m',
    `Content-Type: text/plain; name="a-${String(i).padStart(digits, '0')}.${ext(i)}"`,
    'Content-Disposition: attachment',
    '',
    `part ${i}`,
  ]).flat();
  return crlf([
    `Subject: ${count} files`,
    'From: <sender@example.org>',
    'Content-Type: multipart/mixed; boundary="m"',
    '',
    '--m',
    'Content-Type: text/plain',
    '',
    'See the files.',
    ...parts,
    '--m--',
    '',
  ]);
}

/** Writes the messages and makes them the reader's test source; returns the folder. */
async function source(pev: PevApp, name: string): Promise<string> {
  const root = realpathSync(testDir(name));
  writeFileSync(join(root, 'mixed.eml'), MIXED);
  writeFileSync(join(root, 'fifty.eml'), many(50));
  writeFileSync(join(root, 'many.eml'), many(120));
  writeFileSync(join(root, 'most.eml'), many(MAX_MIME_PARTS + 10, 5));
  writeFileSync(join(root, 'risky.eml'), many(90, 3, 3));
  const result = await pev.main<{ ok: boolean }>('readerSource', root, [
    [1, { file: 'mixed.eml' }],
    [2, { file: 'fifty.eml' }],
    [3, { file: 'many.eml' }],
    [4, { file: 'most.eml' }],
    [5, { file: 'risky.eml' }],
  ]);
  expect(result.ok).toBe(true);
  return root;
}

function openInReader(pev: PevApp, rowid: number, mode?: OpenMode): Promise<MessageOpenResult> {
  return pev.shell<MessageOpenResult>('openInReader', mode ? [rowid, mode] : [rowid]);
}

interface ShownView {
  url: string;
  attachments: Array<Record<string, unknown>>;
}

/** Waits until the pane shows the latest view, and returns it. */
async function shown(pev: PevApp): Promise<ShownView> {
  await expect
    .poll(async () => {
      const r = await pev.shell<{ pending: boolean; view: { url: string } | null }>('reader');
      const src = await pev.page.locator('.rp-frame').getAttribute('src');
      return !r.pending && r.view !== null && src === r.view.url;
    })
    .toBe(true);
  const r = await pev.shell<{ view: ShownView }>('reader');
  await pev.bodyFrame(r.view.url);
  return r.view;
}

const pane = (pev: PevApp) => pev.page.locator('.rp');
const external = (pev: PevApp) => pev.main<ExternalCall[]>('externalCalls');

/** Hidden windows get no frames to click or scroll in: events are sent directly. */
const press = (page: Page, selector: string) => page.locator(selector).dispatchEvent('click');

async function scrollAttachments(page: Page, top: number): Promise<void> {
  await page.evaluate((y) => {
    const el = document.querySelector<HTMLElement>('.rp-att-list');
    if (!el) throw new Error('no list');
    el.scrollTop = y;
    el.dispatchEvent(new Event('scroll'));
  }, top);
}

/** Sends a request on a channel straight to main, as any shell code could. */
function invoke(pev: PevApp, channel: string, ...args: unknown[]): Promise<unknown> {
  return pev.page.evaluate(([c, a]) => window.__pevTestIpc.invoke(c, ...a), [
    channel,
    args,
  ] as const);
}

const CHANNELS = { showInFolder: 'pev:show-in-folder', copyMessageId: 'pev:copy-message-id' };

/** An action on the open message, as the shell sends it. */
function action(
  pev: PevApp,
  name: keyof typeof CHANNELS,
  openId: number,
  generation: number,
): Promise<ReaderActionResult> {
  return invoke(pev, CHANNELS[name], { openId, generation }) as Promise<ReaderActionResult>;
}

async function generationNow(pev: PevApp): Promise<number> {
  return ((await invoke(pev, 'pev:state')) as { generation: number }).generation;
}

test('the list shows each attachment and leaves out the image the HTML body shows', async ({
  pev,
}) => {
  await source(pev, 'att-list');
  await openInReader(pev, 1);
  const view = await shown(pev);
  const list = pane(pev).locator('.rp-atts');
  await expect(list.locator('.rp-att-title')).toHaveText('4 attachments');
  await expect(list.locator('.rp-att-name')).toHaveText([
    'report.pdf',
    'notes.txt',
    'attachment',
    'setup.exe',
  ]);
  await expect(list.locator('.rp-att-meta')).toHaveText([
    'PDF document · 15 bytes',
    'Text · 13 bytes',
    'File · 3 bytes',
    'Windows program · 10 bytes',
  ]);
  // Only the program file is marked.
  await expect(list.locator('.rp-att-risky')).toHaveCount(1);
  await expect(list.locator('.rp-att-risky .rp-att-name')).toHaveText('setup.exe');
  await expect(list.locator('.rp-att-risky .rp-att-warn')).toHaveText(
    'Program file. It can harm your computer.',
  );
  // The shell gets an index per row, never the part it is.
  expect(view.attachments.map((a) => Object.keys(a).sort())).toEqual(
    Array(4).fill(['imageFormat', 'index', 'label', 'name', 'risky', 'size']),
  );
  expect(view.attachments.map((a) => a.index)).toEqual([0, 1, 2, 3]);

  // In plain text the body shows no image, so the image is listed too.
  await openInReader(pev, 1, 'plain');
  await shown(pev);
  await expect(list.locator('.rp-att-title')).toHaveText('5 attachments');
  await expect(list.locator('.rp-att-name').first()).toHaveText('logo.png');
  await expect(list.locator('.rp-att-meta').first()).toHaveText(
    `PNG image · ${fileSize(PNG.length)}`,
  );
});

test('past 50 attachments only the rows in view are made', async ({ pev }) => {
  await source(pev, 'att-many');
  await openInReader(pev, 2);
  await shown(pev);
  const list = pane(pev).locator('.rp-atts');
  await expect(list.locator('.rp-att-title')).toHaveText('50 attachments');
  await expect(list.locator('.rp-att')).toHaveCount(50);

  await openInReader(pev, 3);
  await shown(pev);
  await expect(list.locator('.rp-att-title')).toHaveText('120 attachments');
  const made = await list.locator('.rp-att').count();
  expect(made).toBeGreaterThan(0);
  expect(made).toBeLessThan(20);
  await expect(list.locator('.rp-att-name').first()).toHaveText('a-000.txt');
  await scrollAttachments(pev.page, 120 * 56);
  await expect(list.locator('.rp-att-name').last()).toHaveText('a-119.txt');
  expect(await list.locator('.rp-att').count()).toBeLessThan(20);

  // Past the part limit: every attachment read before it is listed, still virtual.
  await openInReader(pev, 4);
  await shown(pev);
  const title = (await list.locator('.rp-att-title').textContent()) ?? '';
  const n = Number(/^([\d,]+) attachments$/.exec(title)?.[1]?.replace(/,/g, ''));
  expect(n).toBeGreaterThan(MAX_MIME_PARTS - 10);
  expect(n).toBeLessThan(MAX_MIME_PARTS);
  await expect(list.locator('.rp-att-name').first()).toHaveText('a-00000.txt');
  expect(await list.locator('.rp-att').count()).toBeLessThan(20);
  await scrollAttachments(pev.page, n * 56);
  await expect(list.locator('.rp-att-name').last()).toHaveText(
    `a-${String(n - 1).padStart(5, '0')}.txt`,
  );
  expect(await list.locator('.rp-att').count()).toBeLessThan(20);
});

/** The rows made, top to bottom, with whether any of their content is cut off. */
function rowBoxes(pev: PevApp) {
  return pane(pev)
    .locator('.rp-att')
    .evaluateAll((rows) =>
      rows
        .map((row) => {
          const box = row.getBoundingClientRect();
          const warn = row.querySelector<HTMLElement>('.rp-att-warn span');
          return {
            top: box.top,
            bottom: box.bottom,
            risky: row.classList.contains('rp-att-risky'),
            clipped: row.scrollHeight > row.clientHeight,
            warnCut: warn !== null && warn.scrollWidth > warn.clientWidth,
          };
        })
        .sort((a, b) => a.top - b.top),
    );
}

test('in a long list, a program file row shows its whole warning, and rows never overlap', async ({
  pev,
}) => {
  await source(pev, 'att-risky');
  await openInReader(pev, 5);
  await shown(pev);
  const list = pane(pev).locator('.rp-atts');
  await expect(list.locator('.rp-att-title')).toHaveText('90 attachments');
  for (const at of [0, 30 * 60, 90 * 72]) {
    await scrollAttachments(pev.page, at);
    await expect.poll(async () => (await rowBoxes(pev)).some((b) => b.risky)).toBe(true);
    const boxes = await rowBoxes(pev);
    expect(boxes.length).toBeLessThan(20);
    expect(boxes.filter((b) => b.clipped || b.warnCut)).toEqual([]);
    for (let i = 1; i < boxes.length; i += 1) {
      expect(boxes[i]!.top).toBeGreaterThanOrEqual(boxes[i - 1]!.bottom);
    }
  }
  await expect(list.locator('.rp-att-name').last()).toHaveText('a-089.txt');
});

test('Details adds the Message-ID, the References and the format, cleaned for display', async ({
  pev,
}) => {
  await source(pev, 'att-details');
  await openInReader(pev, 1);
  await shown(pev);
  await press(pev.page, '.rp .rp-linkish');
  const details = pane(pev).locator('.rp-details');
  await expect(details.locator('dt')).toHaveText([
    'From',
    'To',
    'Date',
    'Message-ID',
    'References',
    'Format',
  ]);
  const dd = details.locator('dd');
  await expect(dd.nth(3)).toHaveText('<amoc.elpmaxe@1>');
  // The first 20 References, then how many more there are.
  await expect(dd.nth(4).locator('div')).toHaveText([
    ...REFS.slice(0, MAX_REFERENCES),
    'and 3 more',
  ]);
  await expect(dd.nth(5)).toHaveText('multipart/mixed · HTML and plain text · 4 attachments');
});

test('Show in folder and Copy Message-ID each make one recorded call for the open message', async ({
  pev,
}) => {
  const root = await source(pev, 'att-actions');
  await openInReader(pev, 1);
  await shown(pev);
  await press(pev.page, '.rp .rp-show');
  await expect
    .poll(() => external(pev))
    .toEqual([{ method: 'shell.showItemInFolder', args: [join(root, 'mixed.eml')] }]);
  await press(pev.page, '.rp .rp-copy-id');
  await expect(pane(pev).locator('.rp-note')).toHaveText('Message-ID copied.');
  expect(await external(pev)).toEqual([
    { method: 'shell.showItemInFolder', args: [join(root, 'mixed.eml')] },
    { method: 'clipboard.writeText', args: ['<amoc.elpmaxe@1>'] },
  ]);
  // Each logs its code and the window, never the path or the ID.
  expect(pev.hasLog('reader.show_in_folder', { windowId: 1 })).toBe(true);
  expect(pev.hasLog('reader.copy_message_id', { windowId: 1 })).toBe(true);
  for (const line of pev.logs()) {
    const text = JSON.stringify(line);
    expect(text).not.toContain('mixed.eml');
    expect(text).not.toContain('elpmaxe');
  }

  // A message without a Message-ID has nothing to copy.
  await openInReader(pev, 2);
  await shown(pev);
  await expect(pane(pev).locator('.rp-copy-id')).toBeDisabled();
  await expect(pane(pev).locator('.rp-show')).toBeEnabled();
});

test('the action channels refuse extra fields, a stale generation and an older open', async ({
  pev,
}) => {
  await source(pev, 'att-refuse');
  const first = await openInReader(pev, 1);
  await shown(pev);
  expect(first.ok).toBe(true);
  const openId = (first as { openId: number }).openId;
  const gen = await generationNow(pev);

  for (const name of ['showInFolder', 'copyMessageId'] as const) {
    expect(await action(pev, name, openId, gen + 1)).toEqual({
      ok: false,
      code: 'stale_generation',
    });
    expect(await action(pev, name, openId + 1, gen)).toEqual({ ok: false, code: 'superseded' });
  }
  // Extra fields or arguments, a missing field, a wrong type.
  for (const channel of Object.values(CHANNELS)) {
    for (const args of [
      [{ openId, generation: gen, path: '/etc' }],
      [{ openId, generation: gen }, 'extra'],
      [{ openId }],
      [{ openId: String(openId), generation: gen }],
    ]) {
      expect(await invoke(pev, channel, ...args), `${channel} ${JSON.stringify(args)}`).toEqual({
        ok: false,
        code: 'invalid',
      });
    }
  }

  // A newer open: the first one names nothing any more.
  await openInReader(pev, 2);
  await shown(pev);
  for (const name of ['showInFolder', 'copyMessageId'] as const) {
    expect(await action(pev, name, openId, gen)).toEqual({ ok: false, code: 'superseded' });
  }
  expect(await external(pev)).toEqual([]);
});

test('a file replaced since the view was read is not shown in its place', async ({ pev }) => {
  const root = await source(pev, 'att-replaced');
  await openInReader(pev, 1);
  await shown(pev);
  const path = join(root, 'mixed.eml');
  writeFileSync(`${path}.new`, readFileSync(path));
  renameSync(`${path}.new`, path);
  await press(pev.page, '.rp .rp-show');
  await expect.poll(() => pev.hasLog('ipc.rejected', { reason: 'changed' })).toBe(true);
  expect(await external(pev)).toEqual([]);
});

test('while the export is offline no message is open, and Show in folder is never offered', async ({
  pev,
}) => {
  const root = realpathSync(testDir('att-offline'));
  const written = writeExport(root, { seed: 71, messages: 6 });
  await pev.main('queuePick', root, 'bm1');
  await pev.shell('chooseFolder', []);
  await expect
    .poll(
      async () =>
        (
          await pev.main<{ answer: IndexTotals; progress: IndexProgress } | null>('indexQuery', {
            op: 'totals',
          })
        )?.progress,
      { timeout: 20_000 },
    )
    .toMatchObject({ phase: 'done', loaded: written.pairs, total: written.pairs });
  const opened = await openInReader(pev, 1);
  expect(opened.ok).toBe(true);
  await shown(pev);
  await expect(pane(pev).locator('.rp-show')).toBeEnabled();
  const openId = (opened as { openId: number }).openId;

  const key = (await pev.main<Stamp>('sourceStamp')).sourceKey;
  const away = realpathSync(testDir('att-offline-away'));
  renameSync(join(written.root, written.account), join(away, written.account));
  expect(await pev.shell('openExport', [key])).toMatchObject({ outcome: 'offline' });
  // The switch closed the view; nothing in the pane offers Show in folder.
  await expect(pane(pev).locator('.rp-show:enabled')).toHaveCount(0);
  expect(await action(pev, 'showInFolder', openId, await generationNow(pev))).toEqual({
    ok: false,
    code: 'superseded',
  });
  // An open while offline is refused before any view exists.
  await openInReader(pev, 1);
  await expect
    .poll(async () => (await pev.shell<{ refused: string }>('reader')).refused)
    .toBe('offline');
  await expect(pane(pev).locator('.rp-show')).toHaveCount(0);
  expect(await external(pev)).toEqual([]);
});
