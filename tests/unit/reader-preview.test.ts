// SPDX-License-Identifier: AGPL-3.0-or-later
// Which attachments get a preview: only a part whose whole decoded bytes, at
// most PREVIEW_MAX_BYTES, pass the raster check. The declared type and the
// name play no part. One candidate is held at a time, and a read checks at
// most its budget of candidates; the ones past it get none and are counted.

import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { KEEP_BYTES, extractMessage } from '../../src/core/reader/extract';
import { renderMessage } from '../../src/core/reader/render';
import { PREVIEW_MAX_BYTES } from '../../src/shared/reader-protocol';
import { INLINE_BOMBS } from '../../tools/gen-export/hostile.mjs';
import {
  gifImage,
  jpegImage,
  paddedPng,
  solidPng,
  webpImage,
} from '../../tools/gen-export/images.mjs';

const BASE = 'mail-asset://v/0123456789abcdef0123456789abcdef';

interface Part {
  name: string;
  type: string;
  bytes: Uint8Array;
}

/** A message with a short text body and these attachments, each in base64. */
function message(parts: Part[]): Buffer {
  const lines = [
    'Subject: Preview',
    'Content-Type: multipart/mixed; boundary="m"',
    '',
    '--m',
    'Content-Type: text/plain',
    '',
    'Hi',
  ];
  for (const part of parts) {
    lines.push(
      '--m',
      `Content-Type: ${part.type}`,
      `Content-Disposition: attachment; filename="${part.name}"`,
      'Content-Transfer-Encoding: base64',
      '',
      // One string: a 25 MB part is too many lines to spread into push().
      (
        Buffer.from(part.bytes)
          .toString('base64')
          .match(/.{1,76}/g) ?? []
      ).join('\r\n'),
    );
  }
  lines.push('--m--', '');
  return Buffer.from(lines.join('\r\n'));
}

function render(bytes: Buffer, options: { previewCheckBytes?: number } = {}) {
  const unchecked: number[] = [];
  const rendered = renderMessage(Readable.from([bytes]), {
    mode: 'plain',
    assetBase: BASE,
    reread: { open: () => Promise.resolve(Readable.from([bytes])) },
    onPreviewUnchecked: (count) => unchecked.push(count),
    ...options,
  });
  return rendered.then((r) => ({ ...r, unchecked }));
}

const image = (name: string, bytes: Uint8Array): Part => ({ name, type: 'image/png', bytes });

describe('attachment preview candidates', () => {
  it('a valid PNG, JPEG, GIF and WebP get a preview with the format and canvas the check found', async () => {
    const r = await render(
      message([
        image('a.png', solidPng(20, 10, [1, 2, 3])),
        image('b.jpg', jpegImage(30, 12)),
        image('c.gif', gifImage(7, 5, 1)),
        image('d.webp', webpImage(9, 4)),
      ]),
    );
    expect(r.attachments.map((a) => a.preview)).toEqual([
      { format: 'png', width: 20, height: 10 },
      { format: 'jpeg', width: 30, height: 12 },
      { format: 'gif', width: 7, height: 5 },
      { format: 'webp', width: 9, height: 4 },
    ]);
    expect(r.unchecked).toEqual([]);
  });

  it('a raster bomb of each kind has an image signature and gets no preview', async () => {
    const entries = Object.entries(INLINE_BOMBS);
    const r = await render(message(entries.map(([name, [make]]) => image(`${name}.png`, make()))));
    expect(r.attachments).toHaveLength(entries.length);
    for (const a of r.attachments) {
      expect(a.imageFormat, a.name).not.toBeNull();
      expect(a.preview, a.name).toBeNull();
    }
  });

  it('the bytes decide: a non-image named and declared as PNG gets none, an image declared as text gets one', async () => {
    const r = await render(
      message([
        { name: 'fake.png', type: 'image/png', bytes: Buffer.from('not an image, only text here') },
        { name: 'photo.txt', type: 'text/plain', bytes: solidPng(3, 2, [9, 9, 9]) },
        { name: 'photo.bin', type: 'application/octet-stream', bytes: jpegImage(4, 4) },
      ]),
    );
    expect(r.attachments.map((a) => a.preview)).toEqual([
      null,
      { format: 'png', width: 3, height: 2 },
      { format: 'jpeg', width: 4, height: 4 },
    ]);
  });

  it('a part of exactly the cap gets a preview; one byte over gets none, keeps its full size, and is let go at the cap', async () => {
    const atCap = await extractMessage(
      Readable.from([message([image('cap.png', paddedPng(PREVIEW_MAX_BYTES))])]),
    );
    expect(atCap.listed[0]).toMatchObject({
      size: PREVIEW_MAX_BYTES,
      preview: { format: 'png', width: 1, height: 1 },
    });
    const over = await extractMessage(
      Readable.from([message([image('over.png', paddedPng(PREVIEW_MAX_BYTES + 1))])]),
    );
    expect(over.listed[0]).toMatchObject({ size: PREVIEW_MAX_BYTES + 1, preview: null });
    expect(over.previewHeldPeak).toBeLessThanOrEqual(PREVIEW_MAX_BYTES);
  });

  it('holds one candidate at a time, and lets a non-image go after its first bytes', async () => {
    const a = paddedPng(300_000);
    const b = paddedPng(200_000);
    const read = await extractMessage(
      Readable.from([
        message([
          image('a.png', a),
          image('b.png', b),
          { name: 'big.bin', type: 'application/octet-stream', bytes: Buffer.alloc(900_000, 7) },
        ]),
      ]),
    );
    expect(read.listed.map((p) => p.preview?.format ?? null)).toEqual(['png', 'png', null]);
    expect(read.previewHeldPeak).toBe(a.length);
  });

  it('past the read’s check budget, later candidates get none and are counted; non-images aren’t', async () => {
    const png = solidPng(4, 4, [0, 0, 0]);
    const parts = [
      image('1.png', png),
      image('2.png', png),
      { name: 'x.bin', type: 'application/octet-stream', bytes: Buffer.alloc(64, 1) },
      image('3.png', png),
      image('4.png', png),
    ];
    const r = await render(message(parts), { previewCheckBytes: 2 * png.length });
    expect(r.attachments.map((a) => a.preview !== null)).toEqual([true, true, false, false, false]);
    expect(r.unchecked).toEqual([2]);
    const read = await extractMessage(Readable.from([message(parts)]), KEEP_BYTES, png.length * 2);
    expect(read.previewUnchecked).toBe(2);
  });

  it('an image past the cap that the spent budget let go is not counted as unchecked', async () => {
    const png = solidPng(4, 4, [0, 0, 0]);
    // Streamed in pieces, as a file is read: the budget runs out at the big
    // image's first bytes, and the image ends past the cap.
    const parts = [image('1.png', png), image('big.png', paddedPng(PREVIEW_MAX_BYTES + 1))];
    const bytes = message(parts);
    const pieces: Buffer[] = [];
    for (let at = 0; at < bytes.length; at += 64 * 1024) {
      pieces.push(bytes.subarray(at, at + 64 * 1024));
    }
    const read = await extractMessage(Readable.from(pieces), KEEP_BYTES, png.length + 1);
    expect(read.listed.map((l) => l.preview !== null)).toEqual([true, false]);
    expect(read.previewUnchecked).toBe(0);
  });

  it('a non-image too short to tell by its signature uses none of the budget', async () => {
    const png = solidPng(4, 4, [0, 0, 0]);
    const parts = [
      { name: 'short.bin', type: 'application/octet-stream', bytes: Buffer.from('hey') },
      image('1.png', png),
    ];
    const read = await extractMessage(Readable.from([message(parts)]), KEEP_BYTES, png.length);
    expect(read.listed.map((l) => l.preview !== null)).toEqual([false, true]);
    expect(read.previewUnchecked).toBe(0);
  });

  it('a bomb counts against the budget like any checked candidate', async () => {
    const bomb = INLINE_BOMBS['apng-frames']![0]();
    const png = solidPng(2, 2, [5, 5, 5]);
    const r = await render(message([image('bomb.png', bomb), image('ok.png', png)]), {
      previewCheckBytes: bomb.length,
    });
    expect(r.attachments.map((a) => a.preview)).toEqual([null, null]);
    expect(r.unchecked).toEqual([1]);
  });
});
