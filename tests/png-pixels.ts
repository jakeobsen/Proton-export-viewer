// SPDX-License-Identifier: AGPL-3.0-or-later
// Reads pixels from a PNG screenshot: 8-bit RGB or RGBA, not interlaced, as
// Chromium writes them.

import { inflateSync } from 'node:zlib';

export type Rgb = [number, number, number];

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** The width, height and unfiltered rows of a PNG. */
export function decodePng(png: Buffer): {
  width: number;
  height: number;
  pixel: (x: number, y: number) => Rgb;
} {
  let at = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const data: Buffer[] = [];
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString('ascii', at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, color, , , interlace] = body.subarray(8, 13);
      if (depth !== 8 || interlace !== 0 || (color !== 2 && color !== 6)) {
        throw new Error(`unsupported PNG: depth ${depth}, colour type ${color}`);
      }
      channels = color === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      data.push(body);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const rows = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? (rows[y * stride + i - channels] ?? 0) : 0;
      const up = y > 0 ? (rows[(y - 1) * stride + i] ?? 0) : 0;
      const upLeft = y > 0 && i >= channels ? (rows[(y - 1) * stride + i - channels] ?? 0) : 0;
      const value = line[i] ?? 0;
      const predicted =
        filter === 1
          ? left
          : filter === 2
            ? up
            : filter === 3
              ? (left + up) >> 1
              : filter === 4
                ? paeth(left, up, upLeft)
                : 0;
      rows[y * stride + i] = (value + predicted) & 0xff;
    }
  }
  return {
    width,
    height,
    pixel: (x, y) => {
      const i = y * stride + x * channels;
      return [rows[i] ?? 0, rows[i + 1] ?? 0, rows[i + 2] ?? 0];
    },
  };
}

/** The colour at the middle of a PNG. */
export function middlePixel(png: Buffer): Rgb {
  const image = decodePng(png);
  return image.pixel(Math.floor(image.width / 2), Math.floor(image.height / 2));
}
