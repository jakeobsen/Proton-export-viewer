// SPDX-License-Identifier: AGPL-3.0-or-later
// The source view: the MIME tree and the raw headers, shown as inert text in
// the body frame under the view's own token; the 256 KB cap; Copy headers;
// Back to message without a new open; View source on the reader's fallback,
// with the tree only when the structure can be read; the tree past 50 parts
// with the keyboard; and nothing that leaves the protocols or reaches a log.

import { realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { MessageOpenResult } from '../../src/shared/api';
import { findMarkers, MARKER_TEXT } from '../markers';
import { testDir } from '../paths';
import { expect, test, type PevApp } from './app';

interface ExternalCall {
  method: string;
  args: string[];
}

const crlf = (lines: string[]) => lines.join('\r\n');
const MB = 1024 * 1024;

const NESTED = crlf([
  'Subject: Nested',
  'From: "Ana Lee" <ana@example.org>',
  'Date: Wed, 25 Nov 2026 08:02:11 +0100',
  'Content-Type: multipart/mixed; boundary="mx"',
  '',
  '--mx',
  'Content-Type: multipart/alternative; boundary="alt"',
  '',
  '--alt',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'hello',
  '--alt',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>hello</p>',
  '--alt--',
  '--mx',
  'Content-Type: application/pdf; name="report.pdf"',
  'Content-Disposition: attachment; filename="report.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('%PDF-1.4 tiny').toString('base64'),
  '--mx',
  'Content-Type: application/x-msdownload; name="setup.exe"',
  'Content-Disposition: attachment; filename="setup.exe"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('MZ').toString('base64'),
  '--mx--',
  '',
]);

const TAGS = [...'hidden'].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('');
const HOSTILE = crlf([
  `Subject: <script>document.title='ran'</script><img src=x onerror="document.title='ran'">`,
  `X-Bidi: invoice\u202egpj.exe`,
  `X-Control: a\u0001b\u001b[31mc\u007f`,
  `X-Tags: ok${TAGS}`,
  `X-Marker: ${MARKER_TEXT}`,
  'Content-Type: text/plain',
  '',
  'body',
  '',
]);

const LONG = crlf([
  'Subject: Long',
  `X-Long: ${'a'.repeat(300 * 1024)}`,
  'Content-Type: text/plain',
  '',
  'body',
  '',
]);

/** A message with `count` small attachments, so the tree has count + 2 parts. */
function many(count: number): string {
  const parts: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    parts.push(
      '--m',
      `Content-Type: application/octet-stream; name="f${i}.bin"`,
      `Content-Disposition: attachment; filename="f${i}.bin"`,
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(`part ${i}`).toString('base64'),
    );
  }
  return crlf([
    'Subject: Many',
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

/** HTML of about `bytes`, which renders only with more heap than 64 MB. */
function bigHtml(bytes: number): string {
  const cell = '<td style="color:red">x</td>';
  return crlf([
    'Subject: Big',
    'Content-Type: text/html; charset=utf-8',
    '',
    `<table><tr>${cell.repeat(Math.ceil(bytes / cell.length))}</tr></table>`,
    '',
  ]);
}

async function source(pev: PevApp, name: string, files: Record<string, string>): Promise<void> {
  const root = realpathSync(testDir(name));
  const map: Array<[number, { file: string }]> = [];
  let rowid = 0;
  for (const [file, text] of Object.entries(files)) {
    writeFileSync(join(root, file), text);
    rowid += 1;
    map.push([rowid, { file }]);
  }
  expect((await pev.main<{ ok: boolean }>('readerSource', root, map)).ok).toBe(true);
}

const openInReader = (pev: PevApp, rowid: number, mode?: string) =>
  pev.shell<MessageOpenResult>('openInReader', mode ? [rowid, mode] : [rowid]);

interface ReaderNow {
  pending: boolean;
  openId: number | null;
  view: { url: string; openId: number } | null;
  fallback: boolean;
  source: { url: string | null; tree: string; selected: string } | null;
}
const reader = (pev: PevApp) => pev.shell<ReaderNow>('reader');

/** Waits until the pane shows the latest view, and returns its URL. */
async function shown(pev: PevApp): Promise<string> {
  await expect
    .poll(async () => {
      const r = await reader(pev);
      const src = await pev.page.locator('.rp-frame').getAttribute('src');
      return !r.pending && r.view !== null && src === r.view.url;
    })
    .toBe(true);
  const url = (await reader(pev)).view!.url;
  await pev.bodyFrame(url);
  return url;
}

/** Waits until the source view's frame shows document `n`, and returns its URL. */
async function sourceShown(pev: PevApp, n: number): Promise<string> {
  await expect
    .poll(async () => (await pev.page.locator('.sv-frame').getAttribute('src')) ?? '')
    .toMatch(new RegExp(`^mail-body://v/[0-9a-f]{32}/source/${n}$`));
  const url = (await pev.page.locator('.sv-frame').getAttribute('src'))!;
  await pev.bodyFrame(url);
  return url;
}

const frameText = async (pev: PevApp, url: string) =>
  (await pev.bodyFrame(url)).locator('body').innerText();

/** Hidden windows get no frames to click in: events are sent directly. */
const press = (page: Page, selector: string) => page.locator(selector).dispatchEvent('click');
const external = (pev: PevApp) => pev.main<ExternalCall[]>('externalCalls');
const invoke = (pev: PevApp, channel: string, ...args: unknown[]) =>
  pev.page.evaluate(([c, a]) => window.__pevTestIpc.invoke(c, ...a), [channel, args] as const);

test('Source shows the tree and the raw headers under the view’s token, a part’s headers on selection, and Back the same view', async ({
  pev,
}) => {
  await source(pev, 'src-nested', { 'nested.eml': NESTED });
  await openInReader(pev, 1);
  const body = await shown(pev);
  const token = /\/([0-9a-f]{32})$/.exec(body)![1]!;
  const openId = (await reader(pev)).openId;
  const installed = pev.logs('main').filter((l) => l.code === 'view.installed').length;

  await press(pev.page, '.rp-source');
  const first = await sourceShown(pev, 1);
  expect(first).toBe(`mail-body://v/${token}/source/1`);
  expect(await frameText(pev, first)).toContain('Subject: Nested');
  await expect(pev.page.locator('.sv-subject')).toHaveText('Nested');
  const rows = pev.page.locator('.sv-node');
  await expect(rows.locator('.sv-ct')).toHaveText([
    'multipart/mixed',
    'multipart/alternative',
    'text/plain',
    'text/html',
    'application/pdf',
    'application/x-msdownload',
  ]);
  await expect(rows.nth(2).locator('.sv-tag')).toHaveText(['utf-8']);
  await expect(rows.nth(4).locator('.sv-tag')).toHaveText(['report.pdf']);
  await expect(rows.nth(5).locator('.sv-danger')).toHaveText('.exe');
  await expect(rows.nth(4).locator('.sv-sz')).toHaveText('13 bytes');

  await press(pev.page, '.sv-node[data-path="1.2"]');
  const part = await sourceShown(pev, 2);
  const text = await frameText(pev, part);
  expect(text).toContain('Content-Type: application/pdf; name="report.pdf"');
  expect(text).not.toContain('Subject: Nested');
  await expect(rows.nth(4)).toHaveAttribute('aria-selected', 'true');
  // The old document is gone, and only the new one may load.
  expect(await invoke(pev, 'pev:state')).toBeTruthy();
  const old = await pev.main<{ status: number }>('fetchIn', 1, first);
  expect(old.status).toBe(404);

  await press(pev.page, '.sv-back');
  await expect(pev.page.locator('.sv')).toHaveCount(0);
  expect(await shown(pev)).toBe(body);
  expect((await reader(pev)).openId).toBe(openId);
  expect(pev.logs('main').filter((l) => l.code === 'view.installed')).toHaveLength(installed);
});

test('a header with script, bidi, control and tag characters shows as inert text with visible escapes', async ({
  pev,
}) => {
  await source(pev, 'src-hostile', { 'hostile.eml': HOSTILE });
  await openInReader(pev, 1);
  await shown(pev);
  await press(pev.page, '.rp-source');
  const url = await sourceShown(pev, 1);
  const frame = await pev.bodyFrame(url);
  await expect(frame.locator('script, img')).toHaveCount(0);
  expect(await frame.evaluate(() => document.title)).not.toBe('ran');
  const text = await frame.locator('pre').innerText();
  expect(text).toContain("<script>document.title='ran'</script>");
  expect(text).toContain('X-Bidi: invoice<U+202E>gpj.exe');
  expect(text).toContain('X-Control: a<U+0001>b<U+001B>[31mc<U+007F>');
  expect(text).toContain('X-Tags: ok<U+E0068><U+E0069><U+E0064><U+E0064><U+E0065><U+E006E>');
  await expect(frame.locator('.esc')).toHaveCount(1 + 3 + 6);
  // No character that hides or reorders text is in the document.
  const doc = await frame.content();
  for (const ch of ['\u202e', '\u0001', '\u001b', '\u007f']) {
    expect(doc.includes(ch), `U+${ch.codePointAt(0)!.toString(16)}`).toBe(false);
  }
  // Nothing about the headers reaches a log.
  expect(findMarkers(JSON.stringify(pev.logs()))).toEqual([]);
});

const NAMES = crlf([
  'From: "\u202e\u200b" <bo@example.org>',
  'Subject: \u202eInvoice\u200b\tdue\u0001',
  'Content-Type: text/plain',
  '',
  'body',
  '',
]);

test('the source view shows the subject and the sender cleaned and isolated, as the reader does', async ({
  pev,
}) => {
  await source(pev, 'src-names', { 'names.eml': NAMES });
  await openInReader(pev, 1);
  await shown(pev);
  await press(pev.page, '.rp-source');
  await sourceShown(pev, 1);
  await expect(pev.page.locator('.sv-subject')).toHaveText('Invoice due\u2401');
  // A name of only invisible characters gives way to the address.
  await expect(pev.page.locator('.sv-sender')).toHaveText('bo@example.org');
  for (const selector of ['.sv-subject', '.sv-sender']) {
    const bidi = await pev.page
      .locator(selector)
      .evaluate((el) => getComputedStyle(el).unicodeBidi);
    expect(bidi, selector).toBe('isolate');
  }
});

test('a header block over 256 KB shows its first 256 KB, and says so', async ({ pev }) => {
  await source(pev, 'src-long', { 'long.eml': LONG });
  await openInReader(pev, 1);
  await shown(pev);
  await press(pev.page, '.rp-source');
  const url = await sourceShown(pev, 1);
  const frame = await pev.bodyFrame(url);
  await expect(frame.locator('.cut')).toHaveText('First 256 KB shown');
  const text = await frame.locator('pre').innerText();
  expect(text.startsWith('Subject: Long\nX-Long: aaa')).toBe(true);
  expect(text.length).toBeLessThanOrEqual(256 * 1024);
  expect(text.length).toBeGreaterThan(255 * 1024);
});

test('Copy headers makes one recorded clipboard call with the block shown, and only in the source view', async ({
  pev,
}) => {
  await source(pev, 'src-copy', { 'hostile.eml': HOSTILE });
  await openInReader(pev, 1);
  await shown(pev);
  const before = (await external(pev)).length;
  await press(pev.page, '.rp-source');
  await sourceShown(pev, 1);
  await press(pev.page, '.sv-bar .btn');
  await expect(pev.page.locator('.sv-note')).toHaveText('Headers copied.');
  const calls = (await external(pev)).slice(before);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.method).toBe('clipboard.writeText');
  expect(calls[0]!.args[0]).toContain('X-Bidi: invoice<U+202E>gpj.exe\n');
  expect(await pev.main('externalStubbed')).toBe(true);

  // Once the source view is left, a copy for it is refused.
  const { openId } = await reader(pev);
  await press(pev.page, '.sv-back');
  await expect(pev.page.locator('.sv')).toHaveCount(0);
  const generation = ((await invoke(pev, 'pev:state')) as { generation: number }).generation;
  expect(await invoke(pev, 'pev:copy-headers', { openId, generation })).toEqual({
    ok: false,
    code: 'superseded',
  });
  expect((await external(pev)).slice(before)).toHaveLength(1);
  expect(findMarkers(JSON.stringify(pev.logs()))).toEqual([]);
});

test('on the fallback, View source shows the headers; the tree shows when the structure can be read, and not when it times out', async ({
  pev,
}) => {
  await source(pev, 'src-fallback', { 'big.eml': bigHtml(6 * MB), 'huge.eml': bigHtml(48 * MB) });
  // Rendering this HTML needs well over this heap; reading its structure doesn't.
  await pev.main('readerLimits', { heapMb: 64 });
  await openInReader(pev, 1, 'html-anyway');
  await expect(pev.page.locator('.rp-fallback')).toContainText("Couldn't render this message");
  await expect(pev.page.locator('.rp-fallback .rp-view-source')).toHaveText('View source');
  await press(pev.page, '.rp-view-source');
  const url = await sourceShown(pev, 1);
  expect(await frameText(pev, url)).toContain('Subject: Big');
  await expect(pev.page.locator('.sv-node .sv-ct')).toHaveText(['text/html']);
  // Back returns to the fallback line, and no body URL ever loads.
  await press(pev.page, '.sv-back');
  await expect(pev.page.locator('.rp-fallback')).toHaveCount(1);
  await expect(pev.page.locator('.rp-frame')).toHaveCount(0);
  const token = /\/([0-9a-f]{32})\/source\/1$/.exec(url)![1]!;
  expect((await pev.main<{ status: number }>('fetchIn', 1, `mail-body://v/${token}`)).status).toBe(
    404,
  );

  // With a short time limit, the open and the structure both time out; the
  // headers, read without a parse, still show.
  await pev.main('readerLimits', { heapMb: 512, timeoutMs: 100 });
  await openInReader(pev, 2);
  await expect(pev.page.locator('.rp-fallback')).toHaveCount(1);
  await press(pev.page, '.rp-view-source');
  expect(await frameText(pev, await sourceShown(pev, 1))).toContain('Subject: Big');
  await expect.poll(async () => (await reader(pev)).source?.tree).toBe('none');
  await expect(pev.page.locator('.sv-node')).toHaveCount(0);
});

test('past 50 parts the tree makes only the rows in view, and the arrow keys walk across that boundary', async ({
  pev,
}) => {
  await source(pev, 'src-many', { 'many.eml': many(120) });
  await openInReader(pev, 1);
  await shown(pev);
  await press(pev.page, '.rp-source');
  await sourceShown(pev, 1);
  const tree = pev.page.locator('.sv-tree');
  await expect(tree.locator('[role="treeitem"]').first()).toHaveAttribute('data-path', '1');
  expect(await tree.locator('[role="treeitem"]').count()).toBeLessThan(80);
  await tree.locator('[data-index="0"]').focus();
  await tree.dispatchEvent('keydown', { key: 'End' });
  await expect(tree.locator('[data-path="1.121"]')).toBeFocused();
  for (let i = 0; i < 3; i += 1) await tree.dispatchEvent('keydown', { key: 'ArrowUp' });
  await expect(tree.locator('[data-path="1.118"]')).toBeFocused();
  await tree.dispatchEvent('keydown', { key: 'Enter' });
  const url = await sourceShown(pev, 2);
  expect(await frameText(pev, url)).toContain('filename="f117.bin"');
  await tree.dispatchEvent('keydown', { key: 'Home' });
  await expect(tree.locator('[data-path="1"]')).toBeFocused();
  expect(await tree.locator('[role="treeitem"]').count()).toBeLessThan(80);
});

test('the source view makes no request outside the app’s protocols', async ({ pev }) => {
  await source(pev, 'src-requests', { 'nested.eml': NESTED, 'hostile.eml': HOSTILE });
  for (const rowid of [1, 2]) {
    await openInReader(pev, rowid);
    await shown(pev);
    await press(pev.page, '.rp-source');
    await sourceShown(pev, 1);
    await press(pev.page, '.sv-back');
    await expect(pev.page.locator('.sv')).toHaveCount(0);
  }
  const requests = await pev.main<{ blocked: string[]; body: string[] }>('requests', 1);
  expect(requests.blocked).toEqual([]);
  expect(requests.body.every((u) => u.startsWith('mail-body://v/'))).toBe(true);
});
