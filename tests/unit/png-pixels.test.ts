// SPDX-License-Identifier: AGPL-3.0-or-later
// The e2e tests' PNG pixel reader: every row filter, RGB and RGBA.

import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodePng, middlePixel } from '../png-pixels';
import { pngChunk, solidPng } from '../../tools/gen-export/images.mjs';

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** A PNG of `pixels` (rows of [r, g, b, a]), each row with filter `row % 5`. */
function filteredPng(pixels: number[][][]): Buffer {
  const height = pixels.length;
  const width = pixels[0]?.length ?? 0;
  const stride = width * 4;
  const plain = pixels.map((row) => Buffer.from(row.flat()));
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const filter = y % 5;
    const out = Buffer.alloc(stride + 1);
    out[0] = filter;
    for (let i = 0; i < stride; i++) {
      const value = plain[y]?.[i] ?? 0;
      const left = i >= 4 ? (plain[y]?.[i - 4] ?? 0) : 0;
      const up = y > 0 ? (plain[y - 1]?.[i] ?? 0) : 0;
      const upLeft = y > 0 && i >= 4 ? (plain[y - 1]?.[i - 4] ?? 0) : 0;
      const predicted = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filter] ?? 0;
      out[i + 1] = (value - predicted) & 0xff;
    }
    rows.push(out);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('the PNG pixel reader', () => {
  it('reads every row filter of an RGBA image', () => {
    const pixels = Array.from({ length: 10 }, (_, y) =>
      Array.from({ length: 7 }, (_, x) => [
        (x * 37 + y) & 0xff,
        (y * 53) & 0xff,
        (x * y) & 0xff,
        255,
      ]),
    );
    const image = decodePng(filteredPng(pixels));
    expect([image.width, image.height]).toEqual([7, 10]);
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 7; x++) expect(image.pixel(x, y)).toEqual(pixels[y]?.[x]?.slice(0, 3));
    }
  });

  it('reads an RGB image', () => {
    expect(middlePixel(solidPng(5, 3, [12, 34, 56]))).toEqual([12, 34, 56]);
  });
});
