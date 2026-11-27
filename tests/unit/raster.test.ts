// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  MAX_CANVAS_PIXELS,
  MAX_FRAMES,
  MAX_JPEG_SCANS,
  MAX_SIDE,
  MAX_TOTAL_PIXELS,
  checkRaster,
  rasterFormat,
} from '../../src/core/reader/raster';
import {
  apng,
  dimensionBombPng,
  gifImage,
  jpegImage,
  solidPng,
  webpAnimated,
  webpImage,
} from '../../tools/gen-export/images.mjs';

const reason = (bytes: Uint8Array) => {
  const result = checkRaster(bytes);
  return result.ok ? 'ok' : result.reason;
};

const image = (bytes: Uint8Array) => {
  const result = checkRaster(bytes);
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.image;
};

/** A canvas of exactly MAX_CANVAS_PIXELS, within MAX_SIDE on both sides. */
const FULL = { width: 8000, height: MAX_CANVAS_PIXELS / 8000 };

/** Frames of the FULL canvas that just fit MAX_TOTAL_PIXELS. */
const FULL_FRAMES = MAX_TOTAL_PIXELS / MAX_CANVAS_PIXELS;

describe('raster formats', () => {
  it('knows each format by its signature, and gives its Content-Type', () => {
    expect(image(solidPng(2, 3, [1, 2, 3]))).toEqual({
      format: 'png',
      contentType: 'image/png',
      width: 2,
      height: 3,
      frames: 1,
      pixels: 6,
    });
    expect(image(jpegImage(40, 30))).toMatchObject({
      format: 'jpeg',
      contentType: 'image/jpeg',
      width: 40,
      height: 30,
      frames: 1,
    });
    expect(image(gifImage(5, 4, 1))).toMatchObject({
      format: 'gif',
      contentType: 'image/gif',
      width: 5,
      height: 4,
      frames: 1,
    });
    expect(image(webpImage(7, 9))).toMatchObject({ format: 'webp', width: 7, height: 9 });
    expect(image(webpImage(7, 9, { lossy: true }))).toMatchObject({ width: 7, height: 9 });
    expect(image(webpAnimated(10, 10, 3))).toMatchObject({
      format: 'webp',
      contentType: 'image/webp',
      frames: 3,
    });
    expect(image(apng(10, 10, 4))).toMatchObject({ format: 'png', frames: 4, pixels: 400 });
  });

  it('counts an APNG default image that is not the first frame', () => {
    expect(image(apng(10, 10, 4, { separateDefault: true })).frames).toBe(5);
  });

  it('refuses SVG, text and empty input as format', () => {
    expect(reason(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('format');
    expect(reason(Buffer.from('not an image at all'))).toBe('format');
    expect(reason(new Uint8Array(0))).toBe('format');
    expect(rasterFormat(Buffer.from('RIFF\0\0\0\0WAVE'))).toBeNull();
    // BMP, TIFF and ICO are images, but not ones the reader shows.
    expect(reason(Buffer.from('BM\0\0\0\0'))).toBe('format');
    expect(reason(Buffer.from([0x49, 0x49, 0x2a, 0x00]))).toBe('format');
    expect(reason(Buffer.from([0, 0, 1, 0, 1, 0]))).toBe('format');
  });
});

describe('canvas', () => {
  it.each([
    ['png', (w: number, h: number) => dimensionBombPng(w, h)],
    ['gif', (w: number, h: number) => gifImage(w, h, 1)],
    ['webp', (w: number, h: number) => webpImage(w, h)],
    ['webp vp8x', (w: number, h: number) => webpAnimated(w, h, 1)],
    ['jpeg', (w: number, h: number) => jpegImage(w, h)],
  ])('%s: allows MAX_SIDE and MAX_CANVAS_PIXELS, refuses one more', (_name, make) => {
    expect(reason(make(MAX_SIDE, 1))).toBe('ok');
    expect(reason(make(1, MAX_SIDE))).toBe('ok');
    expect(reason(make(MAX_SIDE + 1, 1))).toBe('canvas');
    expect(reason(make(1, MAX_SIDE + 1))).toBe('canvas');
    expect(reason(make(FULL.width, FULL.height))).toBe('ok');
    expect(reason(make(FULL.width, FULL.height + 1))).toBe('canvas');
  });

  it('refuses a canvas without area as a broken container', () => {
    expect(reason(dimensionBombPng(0, 10))).toBe('container');
    expect(reason(gifImage(10, 0, 1, { rect: { x: 0, y: 0, width: 1, height: 1 } }))).toBe(
      'container',
    );
    expect(reason(jpegImage(10, 0))).toBe('container');
  });

  it('refuses a JPEG whose SOF is over the canvas cap', () => {
    expect(reason(jpegImage(65535, 65535))).toBe('canvas');
  });
});

describe('frames', () => {
  it.each([
    ['gif', (n: number) => gifImage(1, 1, n)],
    ['apng', (n: number) => apng(1, 1, n)],
    ['webp', (n: number) => webpAnimated(1, 1, n)],
  ])('%s: allows MAX_FRAMES, refuses one more', (_name, make) => {
    expect(reason(make(MAX_FRAMES))).toBe('ok');
    expect(reason(make(MAX_FRAMES + 1))).toBe('frames');
  });

  it('refuses an APNG with MAX_FRAMES declared and one fcTL more, at the extra fcTL', () => {
    expect(reason(apng(1, 1, MAX_FRAMES + 1, { declared: MAX_FRAMES }))).toBe('frames');
  });

  it('refuses an APNG whose acTL declares more than MAX_FRAMES', () => {
    expect(reason(apng(1, 1, 2, { declared: MAX_FRAMES + 1 }))).toBe('frames');
  });

  it('refuses an APNG whose fcTL count differs from acTL', () => {
    expect(reason(apng(1, 1, 3, { declared: 2 }))).toBe('container');
    expect(reason(apng(1, 1, 2, { declared: 3 }))).toBe('container');
  });

  it('allows MAX_JPEG_SCANS scans and refuses one more', () => {
    expect(reason(jpegImage(8, 8, { scans: MAX_JPEG_SCANS }))).toBe('ok');
    expect(reason(jpegImage(8, 8, { scans: MAX_JPEG_SCANS + 1 }))).toBe('frames');
  });
});

describe('pixels', () => {
  it.each([
    ['gif', (n: number) => gifImage(FULL.width, FULL.height, n)],
    ['apng', (n: number) => apng(FULL.width, FULL.height, n)],
    ['webp', (n: number) => webpAnimated(FULL.width, FULL.height, n)],
  ])('%s: allows frames x canvas = MAX_TOTAL_PIXELS, refuses one frame more', (_name, make) => {
    expect(image(make(FULL_FRAMES)).pixels).toBe(MAX_TOTAL_PIXELS);
    expect(reason(make(FULL_FRAMES + 1))).toBe('pixels');
  });

  it('counts pixels of the canvas, not of the frame rectangles', () => {
    const small = gifImage(1000, 1000, 2);
    expect(image(small).pixels).toBe(2 * 1000 * 1000);
  });
});

describe('frame rectangles', () => {
  const canvas = { width: 20, height: 10 };
  const inside = { x: 10, y: 4, width: 10, height: 6 };
  const outside = [
    ['past the right edge', { x: 12, y: 0, width: 10, height: 1 }],
    ['past the bottom edge', { x: 0, y: 6, width: 1, height: 6 }],
    ['wider than the canvas', { x: 0, y: 0, width: 22, height: 1 }],
  ] as const;

  it('allows frames that touch the canvas edges', () => {
    expect(reason(gifImage(canvas.width, canvas.height, 2, { rect: inside }))).toBe('ok');
    expect(reason(apng(canvas.width, canvas.height, 2, { rect: inside }))).toBe('ok');
    expect(reason(webpAnimated(canvas.width, canvas.height, 2, { rect: inside }))).toBe('ok');
  });

  it.each(outside)('refuses a GIF frame %s', (_name, rect) => {
    expect(reason(gifImage(canvas.width, canvas.height, 2, { rect }))).toBe('container');
  });

  it.each(outside)('refuses an APNG frame %s', (_name, rect) => {
    expect(reason(apng(canvas.width, canvas.height, 2, { rect }))).toBe('container');
  });

  it.each(outside)('refuses a WebP frame %s', (_name, rect) => {
    expect(reason(webpAnimated(canvas.width, canvas.height, 2, { rect }))).toBe('container');
  });

  it('refuses a frame without area', () => {
    const empty = { x: 0, y: 0, width: 0, height: 1 };
    expect(reason(gifImage(10, 10, 2, { rect: empty }))).toBe('container');
    expect(reason(apng(10, 10, 2, { rect: empty }))).toBe('container');
  });
});

describe('the order of the checks', () => {
  it.each([
    ['png', dimensionBombPng(MAX_SIDE + 1, 10).subarray(0, 40)],
    ['gif', gifImage(MAX_SIDE + 1, 10, 1).subarray(0, 20)],
    ['webp', webpAnimated(MAX_SIDE + 1, 10, 2).subarray(0, 40)],
    ['jpeg', jpegImage(MAX_SIDE + 1, 10).subarray(0, 20)],
  ])('%s: a canvas over the cap in a cut file is refused as canvas', (_name, bytes) => {
    expect(reason(bytes)).toBe('canvas');
  });

  const outside = { x: 8, y: 0, width: 4, height: 1 };
  it.each([
    ['gif', gifImage(10, 10, MAX_FRAMES + 1, { rect: outside })],
    ['apng', apng(10, 10, MAX_FRAMES + 1, { declared: MAX_FRAMES, rect: outside })],
    ['webp', webpAnimated(10, 10, MAX_FRAMES + 1, { rect: outside })],
  ])('%s: frame 1001 outside the canvas is refused as frames', (_name, bytes) => {
    expect(reason(bytes)).toBe('frames');
  });
});

describe('truncated and inconsistent containers', () => {
  const valid = {
    png: solidPng(4, 4, [0, 128, 255]),
    apng: apng(4, 4, 3),
    gif: gifImage(4, 4, 2, { full: true }),
    webp: webpImage(4, 4),
    'webp animated': webpAnimated(4, 4, 3),
    jpeg: jpegImage(4, 4, { scans: 2 }),
  };

  it.each(Object.entries(valid))('%s: refuses every cut short of the whole', (_name, bytes) => {
    expect(reason(bytes)).toBe('ok');
    // Every length from just past the signature to one byte short.
    for (let length = 12; length < bytes.length; length++) {
      expect([length, reason(bytes.subarray(0, length))]).toEqual([length, 'container']);
    }
  });

  it.each(Object.entries(valid))('%s: allows bytes after its end', (_name, bytes) => {
    const trailing = Buffer.concat([bytes, Buffer.from('trailing bytes after the end')]);
    expect(reason(trailing)).toBe('ok');
  });

  it('refuses a PNG without IHDR first, with two IHDR, or without IDAT', () => {
    const png = solidPng(2, 2, [0, 0, 0]);
    // IHDR is bytes 8..33; IDAT follows.
    const ihdr = png.subarray(8, 33);
    const rest = png.subarray(33);
    const signature = png.subarray(0, 8);
    expect(reason(Buffer.concat([signature, rest]))).toBe('container');
    expect(reason(Buffer.concat([signature, ihdr, ihdr, rest]))).toBe('container');
    const iend = png.subarray(png.length - 12);
    expect(reason(Buffer.concat([signature, ihdr, iend]))).toBe('container');
  });

  it('refuses a GIF with an unknown block', () => {
    const gif = gifImage(2, 2, 1);
    const broken = Buffer.from(gif);
    broken[broken.length - 1] = 0x00;
    expect(reason(broken)).toBe('container');
  });

  it('refuses a GIF without frames', () => {
    expect(reason(gifImage(2, 2, 0))).toBe('container');
  });

  it('refuses a WebP whose RIFF size is past the end', () => {
    const webp = Buffer.from(webpImage(4, 4));
    webp.writeUInt32LE(webp.length, 4);
    expect(reason(webp)).toBe('container');
  });

  it('refuses a still VP8X WebP whose bitstream size is not the canvas', () => {
    expect(reason(webpAnimated(4, 4, 1, { still: true }))).toBe('container');
  });

  it('refuses a WebP frame whose image data is not the size of its frame', () => {
    const rect = { x: 0, y: 0, width: 2, height: 2 };
    expect(reason(webpAnimated(4, 4, 2, { rect }))).toBe('ok');
    expect(reason(webpAnimated(4, 4, 2, { rect, bitstream: { width: 2, height: 3 } }))).toBe(
      'container',
    );
    expect(reason(webpAnimated(4, 4, 2, { rect, bitstream: { width: 1, height: 2 } }))).toBe(
      'container',
    );
  });

  describe('a WebP chunk that runs past its end, in a RIFF of the right size', () => {
    /** The offset of a chunk's size field, by its fourcc, searching from `from`. */
    const sizeField = (bytes: Buffer, fourcc: string, from = 12) => bytes.indexOf(fourcc, from) + 4;
    const patched = (fourcc: string, size: number, inside?: string) => {
      const bytes = Buffer.from(webpAnimated(4, 4, 2));
      const from = inside ? bytes.indexOf(inside, 12) + 8 : 12;
      bytes.writeUInt32LE(size, sizeField(bytes, fourcc, from));
      expect(bytes.readUInt32LE(4)).toBe(bytes.length - 8);
      return bytes;
    };

    it('at the top level', () => {
      // The last chunk, so nothing after it would show the overrun.
      const bytes = Buffer.from(webpAnimated(4, 4, 2));
      const field = bytes.lastIndexOf('ANMF') + 4;
      bytes.writeUInt32LE(bytes.readUInt32LE(field) + 16, field);
      expect(bytes.readUInt32LE(4)).toBe(bytes.length - 8);
      expect(reason(bytes)).toBe('container');
      expect(reason(patched('ANIM', 64))).toBe('container');
    });

    it('as an ANMF that claims about 4 GB, refused at once', () => {
      const started = Date.now();
      expect(reason(patched('ANMF', 0xfffffff0))).toBe('container');
      expect(Date.now() - started).toBeLessThan(1000);
    });

    it('inside an ANMF', () => {
      expect(reason(patched('VP8L', 64, 'ANMF'))).toBe('container');
    });

    it('inside an ANMF, claiming about 4 GB', () => {
      expect(reason(patched('VP8L', 0xfffffff0, 'ANMF'))).toBe('container');
    });
  });

  it('refuses an animated VP8X WebP without frames', () => {
    expect(reason(webpAnimated(4, 4, 0))).toBe('container');
  });

  it('refuses a JPEG scan before its frame header, and one without a scan', () => {
    const jpeg = jpegImage(4, 4);
    // SOI, then SOF0 (2 + 11 bytes), then SOS.
    const soi = jpeg.subarray(0, 2);
    const sof = jpeg.subarray(2, 15);
    const scanAndEnd = jpeg.subarray(15);
    expect(reason(Buffer.concat([soi, scanAndEnd]))).toBe('container');
    expect(reason(Buffer.concat([soi, sof, Buffer.from([0xff, 0xd9])]))).toBe('container');
    expect(reason(Buffer.concat([soi, sof, sof, scanAndEnd]))).toBe('container');
  });
});
