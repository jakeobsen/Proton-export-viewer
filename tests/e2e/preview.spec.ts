// SPDX-License-Identifier: AGPL-3.0-or-later
// Attachment previews. Only an attachment whose bytes passed the raster check
// gets "Preview". Its bytes come through core's save lane into main, are
// checked again, and are shown in a frame with the body frame's sandbox and
// CSP. The preview goes with its view, with Close and with a newer preview;
// no name of it reaches a log.

import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileSize } from '../../src/renderer/reader-format';
import type { MessageOpenResult, PreviewResult, SaveResult } from '../../src/shared/api';
import { BODY_CSP, BODY_IFRAME_REFERRER, BODY_IFRAME_SANDBOX } from '../../src/shared/constants';
import { PREVIEW_MAX_BYTES } from '../../src/shared/reader-protocol';
import { dimensionBombPng, paddedPng, solidPng } from '../../tools/gen-export/images.mjs';
import { testDir } from '../paths';
import { expect, test, type PevApp } from './app';

const crlf = (lines: string[]) => lines.join('\r\n');
const MARK = 'mk7f3a';
const PNG = solidPng(40, 30, [10, 120, 200]);

interface Part {
  name: string;
  bytes: Buffer;
  type?: string;
}

/** A message with these attachments, base64-encoded. */
function withAttachments(parts: Part[], subject = 'Files'): string {
  return crlf([
    `Subject: ${subject}`,
    'From: <sender@example.org>',
    'Content-Type: multipart/mixed; boundary="m"',
    '',
    '--m',
    'Content-Type: text/plain',
    '',
    'See the files.',
    ...parts.flatMap((p) => [
      '--m',
      `Content-Type: ${p.type ?? 'application/octet-stream'}; name="${p.name}"`,
      `Content-Disposition: attachment; filename="${p.name}"`,
      'Content-Transfer-Encoding: base64',
      '',
      (p.bytes.toString('base64').match(/.{1,76}/g) ?? []).join('\r\n'),
    ]),
    '--m--',
    '',
  ]);
}

/** Writes the messages and makes them the reader's test source. */
async function source(pev: PevApp, name: string, files: Record<string, string>): Promise<void> {
  const root = realpathSync(testDir(name));
  const entries: Array<[number, { file: string }]> = [];
  Object.entries(files).forEach(([file, data], i) => {
    writeFileSync(join(root, file), data);
    entries.push([i + 1, { file }]);
  });
  expect((await pev.main<{ ok: boolean }>('readerSource', root, entries)).ok).toBe(true);
}

interface Reader {
  pending: boolean;
  view: {
    openId: number;
    url: string;
    attachments: Array<{
      index: number;
      name: string;
      preview: { format: string; width: number; height: number } | null;
    }>;
  } | null;
  preview: { url: string; index: number } | null;
}

const reader = (pev: PevApp) => pev.shell<Reader>('reader');

async function open(pev: PevApp, rowid: number): Promise<NonNullable<Reader['view']>> {
  expect((await pev.shell<MessageOpenResult>('openInReader', [rowid])).ok).toBe(true);
  await expect
    .poll(async () => {
      const r = await reader(pev);
      return !r.pending && r.view !== null;
    })
    .toBe(true);
  return (await reader(pev)).view!;
}

/** Sends a request on a channel straight to main, as any shell code could. */
function invoke(pev: PevApp, channel: string, ...args: unknown[]): Promise<unknown> {
  return pev.page.evaluate(([c, a]) => window.__pevTestIpc.invoke(c, ...a), [
    channel,
    args,
  ] as const);
}

const generationNow = async (pev: PevApp) =>
  ((await invoke(pev, 'pev:state')) as { generation: number }).generation;

const status = async (pev: PevApp, url: string) =>
  (await pev.main<{ status: number }>('fetchIn', 1, url)).status;

/** The image URL of a preview document's URL. */
const assetOf = (url: string) => url.replace(/^mail-body:/, 'mail-asset:');

async function previewed(pev: PevApp, index: number): Promise<string> {
  await pev.page.locator(`[data-preview-index="${index}"]`).dispatchEvent('click');
  await expect.poll(async () => (await reader(pev)).preview?.index ?? null).toBe(index);
  return (await reader(pev)).preview!.url;
}

test('a valid image previews in a confined frame, served with the body CSP and the type of its bytes', async ({
  pev,
}) => {
  const name = `${MARK}-photo.png`;
  // Declared as anything: the bytes decide.
  await source(pev, 'preview-valid', { 'one.eml': withAttachments([{ name, bytes: PNG }]) });
  const view = await open(pev, 1);
  expect(view.attachments[0]!.preview).toEqual({ format: 'png', width: 40, height: 30 });
  const url = await previewed(pev, 0);
  expect(url).toMatch(/^mail-body:\/\/v\/[0-9a-f]{32}\/p\d+$/);
  expect(url.startsWith(view.url)).toBe(true);

  const dialog = pev.page.locator('.pv-dialog[role="dialog"]');
  await expect(dialog.locator('#pv-title')).toHaveText(name);
  await expect(dialog.locator('.pv-line')).toHaveText(`PNG · ${fileSize(PNG.length)} · 40 × 30`);
  await expect(dialog.locator('.pv-cancel')).toBeFocused();
  expect(await pev.shell('previewFrames')).toEqual([
    {
      src: url,
      sandbox: BODY_IFRAME_SANDBOX,
      referrerPolicy: BODY_IFRAME_REFERRER,
      tabIndex: -1,
      pointerEvents: 'none',
    },
  ]);
  const frame = await pev.bodyFrame(url);
  await expect
    .poll(() => frame.evaluate(() => document.querySelector('img')?.naturalWidth ?? 0))
    .toBe(40);
  expect(await frame.evaluate(() => document.scripts.length)).toBe(0);

  const doc = await pev.main<{ status: number; headers: Record<string, string> }>(
    'fetchIn',
    1,
    url,
  );
  expect(doc.status).toBe(200);
  expect(doc.headers['content-security-policy']).toBe(BODY_CSP);
  const image = await pev.main<{ status: number; headers: Record<string, string>; length: number }>(
    'fetchIn',
    1,
    assetOf(url),
  );
  expect(image).toMatchObject({ status: 200, length: PNG.length });
  expect(image.headers['content-type']).toBe('image/png');

  // A click in the dialog, then Esc: it closes, and both URLs are gone.
  await dialog.locator('.pv-body').dispatchEvent('click');
  await pev.page.dispatchEvent('body', 'keydown', { key: 'Escape' });
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => pev.hasLog('preview.closed')).toBe(true);
  expect(await status(pev, url)).toBe(404);
  expect(await status(pev, assetOf(url))).toBe(404);
  expect(await pev.shell('previewFrames')).toEqual([]);
  await expect(pev.page.locator('[data-preview-index="0"]')).toBeFocused();
  expect(pev.hasLog('preview.opened')).toBe(true);
  expect(JSON.stringify(pev.logs())).not.toContain(MARK);
});

test('a bomb, a non-image and an image past the cap get no Preview, and a forced one is refused', async ({
  pev,
}) => {
  await source(pev, 'preview-none', {
    'one.eml': withAttachments([
      { name: 'bomb.png', bytes: dimensionBombPng(30000, 30000), type: 'image/png' },
      { name: 'fake.png', bytes: Buffer.from('not an image at all'), type: 'image/png' },
      { name: 'over.png', bytes: paddedPng(PREVIEW_MAX_BYTES + 1), type: 'image/png' },
    ]),
  });
  const view = await open(pev, 1);
  expect(view.attachments.map((a) => a.preview)).toEqual([null, null, null]);
  await expect(pev.page.locator('.rp-att-preview')).toHaveCount(0);
  const generation = await generationNow(pev);
  for (const index of [0, 1, 2, 3]) {
    expect(await invoke(pev, 'pev:preview', { openId: view.openId, index, generation })).toEqual({
      ok: false,
      code: 'no_preview',
    });
  }
  expect(
    pev.logs().filter((l) => l.code === 'preview.refused' && l.data.reason === 'no_preview'),
  ).toHaveLength(4);
  // Only the live view, for the current generation, with a strict request.
  expect(
    await invoke(pev, 'pev:preview', { openId: view.openId, index: 0, generation: generation + 1 }),
  ).toEqual({ ok: false, code: 'stale_generation' });
  expect(
    await invoke(pev, 'pev:preview', { openId: view.openId + 1, index: 0, generation }),
  ).toEqual({ ok: false, code: 'superseded' });
  expect(
    await invoke(pev, 'pev:preview', { openId: view.openId, index: 0, generation, name: 'x' }),
  ).toEqual({ ok: false, code: 'invalid' });
  expect(pev.hasLog('preview.opened')).toBe(false);
});

test('the preview goes with its view: another open, or a source change, closes it and its URLs', async ({
  pev,
}) => {
  await source(pev, 'preview-revoked', {
    'one.eml': withAttachments([{ name: 'a.png', bytes: PNG }]),
    'two.eml': withAttachments([{ name: 'b.png', bytes: PNG }]),
  });
  await open(pev, 1);
  const first = await previewed(pev, 0);
  await open(pev, 2);
  await expect(pev.page.locator('.pv-dialog')).toHaveCount(0);
  expect(await pev.shell('previewFrames')).toEqual([]);
  expect(await status(pev, first)).toBe(404);
  expect(await status(pev, assetOf(first))).toBe(404);

  const second = await previewed(pev, 0);
  // Main moves on, as after a source change, and tells the shell.
  await pev.main('bumpGeneration');
  await pev.main('notifySources');
  await expect(pev.page.locator('.pv-dialog')).toHaveCount(0);
  expect(await status(pev, second)).toBe(404);
  expect(await status(pev, assetOf(second))).toBe(404);
});

test('Save in the dialog saves the attachment through the save lane', async ({ pev }) => {
  await source(pev, 'preview-save', {
    'one.eml': withAttachments([{ name: 'kept.png', bytes: PNG }]),
  });
  await open(pev, 1);
  await previewed(pev, 0);
  await pev.page.locator('.pv-save').dispatchEvent('click');
  const downloads = await pev.main<string>('downloadsDir');
  await expect
    .poll(() => {
      try {
        return readFileSync(join(downloads, 'kept.png')).equals(PNG);
      } catch {
        return false;
      }
    })
    .toBe(true);
});

test('a preview waits behind a held save and runs after it; one whose view went registers nothing', async ({
  pev,
}) => {
  await source(pev, 'preview-queue', {
    'one.eml': withAttachments([
      { name: 'big.bin', bytes: Buffer.alloc(900_000, 7) },
      { name: 'c.png', bytes: PNG },
    ]),
    'two.eml': withAttachments([{ name: 'd.png', bytes: PNG }]),
  });
  await open(pev, 1);
  await pev.main('coreHoldSaves');
  const saving = pev.shell<SaveResult>('saveAttachment', [0]);
  await expect.poll(() => pev.main<number>('coreSavesHeld')).toBe(1);
  const previewing = pev.shell<PreviewResult>('previewAttachment', [1]);
  await pev.page.waitForTimeout(300);
  expect((await reader(pev)).preview).toBeNull();
  await pev.main('coreReleaseSaves');
  expect(await saving).toMatchObject({ ok: true });
  expect(await previewing).toMatchObject({ ok: true });
  expect((await reader(pev)).preview?.index).toBe(1);
  await pev.shell('closePreview');

  // Held behind a save again, then its view is replaced before it runs.
  await pev.main('coreHoldSaves');
  const again = pev.shell<SaveResult>('saveAttachment', [0]);
  await expect.poll(() => pev.main<number>('coreSavesHeld')).toBe(1);
  const late = pev.shell<PreviewResult>('previewAttachment', [1]);
  await open(pev, 2);
  await pev.main('coreReleaseSaves');
  expect(await again).toMatchObject({ ok: true });
  expect(await late).toEqual({ ok: false, code: 'superseded' });
  expect((await reader(pev)).preview).toBeNull();
  expect(pev.hasLog('preview.refused', { reason: 'not_live' })).toBe(true);
  expect(pev.logs().filter((l) => l.code === 'preview.opened')).toHaveLength(1);
});
