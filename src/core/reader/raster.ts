// SPDX-License-Identifier: AGPL-3.0-or-later
// The raster check: whether an inline image may be shown, decided from its
// bytes alone, without decoding a pixel. It knows PNG (APNG included), JPEG,
// GIF and WebP by their signatures, and refuses anything else, SVG included.
// It reads each container through to its end, so that the size a decoder
// would allocate is known before any decoder runs:
// - the canvas: at most MAX_SIDE per side and MAX_CANVAS_PIXELS in all;
// - the frames, counted from the container: GIF image descriptors, APNG
//   `fcTL` chunks (which must equal the count `acTL` declares) and WebP
//   `ANMF` chunks, at most MAX_FRAMES; a JPEG is one frame of at most
//   MAX_JPEG_SCANS scans;
// - every frame lies inside the canvas;
// - frames x canvas is at most MAX_TOTAL_PIXELS.
// A truncated or inconsistent container is refused. The checks run in a fixed
// order (signature, header, then the walk through the container, then the
// pixel total), and the first one that fails gives the reason.

/** The longest side of a canvas, in pixels. */
export const MAX_SIDE = 8192;
/** The largest canvas, in pixels. */
export const MAX_CANVAS_PIXELS = 40_000_000;
/** The most frames of one image. */
export const MAX_FRAMES = 1000;
/** The most pixels of all frames of one image together (frames x canvas). */
export const MAX_TOTAL_PIXELS = 200_000_000;
/** The most scans of one JPEG. */
export const MAX_JPEG_SCANS = 100;

export const RASTER_FORMATS = ['png', 'jpeg', 'gif', 'webp'] as const;
export type RasterFormat = (typeof RASTER_FORMATS)[number];

/** Why an image was refused. */
export const RASTER_REFUSALS = ['format', 'canvas', 'frames', 'pixels', 'container'] as const;
export type RasterRefusal = (typeof RASTER_REFUSALS)[number];

/** The Content-Type each format is served with. */
export const RASTER_CONTENT_TYPES: Readonly<Record<RasterFormat, string>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

export interface RasterImage {
  format: RasterFormat;
  /** The Content-Type of the format found, whatever the message declared. */
  contentType: string;
  width: number;
  height: number;
  /** The images a decoder makes of it: its frames, and a default image shown apart from them. */
  frames: number;
  /** frames x width x height. */
  pixels: number;
}

export type RasterCheck = { ok: true; image: RasterImage } | { ok: false; reason: RasterRefusal };

class Refused extends Error {
  constructor(readonly reason: RasterRefusal) {
    super(reason);
  }
}

function refuse(reason: RasterRefusal): never {
  throw new Refused(reason);
}

const u16be = (b: Uint8Array, at: number): number => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const u16le = (b: Uint8Array, at: number): number => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, at: number): number => u16le(b, at) + (b[at + 2] ?? 0) * 0x10000;
const u32be = (b: Uint8Array, at: number): number => u16be(b, at) * 0x10000 + u16be(b, at + 2);
const u32le = (b: Uint8Array, at: number): number => u16le(b, at) + u16le(b, at + 2) * 0x10000;
const ascii = (b: Uint8Array, from: number, to: number): string =>
  String.fromCharCode(...b.subarray(from, to));

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The format the bytes start with, by signature only, or null. */
export function rasterFormat(b: Uint8Array): RasterFormat | null {
  if (b.length >= 8 && PNG_SIGNATURE.every((v, i) => b[i] === v)) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 6 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) return 'gif';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'webp';
  return null;
}

interface Size {
  width: number;
  height: number;
  frames: number;
}

/** The canvas limits. A canvas without area is a broken container. */
function checkCanvas(width: number, height: number): void {
  if (width < 1 || height < 1) refuse('container');
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_CANVAS_PIXELS) {
    refuse('canvas');
  }
}

/** A frame must have area and lie inside the canvas. */
function checkFrame(
  canvas: { width: number; height: number },
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  if (width < 1 || height < 1 || x + width > canvas.width || y + height > canvas.height) {
    refuse('container');
  }
}

function countFrame(frames: number): number {
  if (frames + 1 > MAX_FRAMES) refuse('frames');
  return frames + 1;
}

// --- PNG and APNG -------------------------------------------------------------

function png(b: Uint8Array): Size {
  let at = 8;
  const chunk = (): { type: string; data: number; length: number } => {
    if (at + 8 > b.length) refuse('container');
    const length = u32be(b, at);
    const type = ascii(b, at + 4, at + 8);
    const data = at + 8;
    if (length > 0x7fffffff || data + length + 4 > b.length) refuse('container');
    at = data + length + 4;
    return { type, data, length };
  };
  const header = chunk();
  if (header.type !== 'IHDR' || header.length !== 13) refuse('container');
  const canvas = { width: u32be(b, header.data), height: u32be(b, header.data + 4) };
  checkCanvas(canvas.width, canvas.height);

  let declared: number | null = null;
  let controls = 0;
  let image = false;
  let firstFrameIsImage = false;
  for (;;) {
    const { type, data, length } = chunk();
    if (type === 'IEND') break;
    if (type === 'IHDR') refuse('container');
    if (type === 'IDAT') {
      image = true;
    } else if (type === 'acTL') {
      if (declared !== null || image || length !== 8) refuse('container');
      declared = u32be(b, data);
      if (declared < 1) refuse('container');
      if (declared > MAX_FRAMES) refuse('frames');
    } else if (type === 'fcTL') {
      if (length !== 26) refuse('container');
      controls = countFrame(controls);
      if (!image) firstFrameIsImage = true;
      checkFrame(
        canvas,
        u32be(b, data + 12),
        u32be(b, data + 16),
        u32be(b, data + 4),
        u32be(b, data + 8),
      );
    } else if (type === 'fdAT') {
      if (!image) refuse('container');
    }
  }
  if (!image) refuse('container');
  if (controls !== (declared ?? 0)) refuse('container');
  // A default image that isn't the animation's first frame is decoded as well.
  const frames = declared === null ? 1 : declared + (firstFrameIsImage ? 0 : 1);
  return { ...canvas, frames };
}

// --- GIF ----------------------------------------------------------------------

/** Skips a run of data sub-blocks; returns the offset after its terminator. */
function subBlocks(b: Uint8Array, from: number): number {
  let at = from;
  for (;;) {
    if (at >= b.length) refuse('container');
    const size = b[at] ?? 0;
    at += 1 + size;
    if (size === 0) return at;
  }
}

function gif(b: Uint8Array): Size {
  if (b.length < 13) refuse('container');
  const canvas = { width: u16le(b, 6), height: u16le(b, 8) };
  checkCanvas(canvas.width, canvas.height);
  const screen = b[10] ?? 0;
  let at = 13;
  if (screen & 0x80) at += 3 * (1 << ((screen & 7) + 1));
  let frames = 0;
  for (;;) {
    if (at >= b.length) refuse('container');
    const block = b[at];
    if (block === 0x3b) break;
    if (block === 0x21) {
      if (at + 2 > b.length) refuse('container');
      at = subBlocks(b, at + 2);
    } else if (block === 0x2c) {
      if (at + 11 > b.length) refuse('container');
      frames = countFrame(frames);
      checkFrame(canvas, u16le(b, at + 1), u16le(b, at + 3), u16le(b, at + 5), u16le(b, at + 7));
      const local = b[at + 9] ?? 0;
      at += 10;
      if (local & 0x80) at += 3 * (1 << ((local & 7) + 1));
      // The LZW minimum code size, then the image data.
      at = subBlocks(b, at + 1);
    } else {
      refuse('container');
    }
  }
  if (frames === 0) refuse('container');
  return { ...canvas, frames };
}

// --- WebP ---------------------------------------------------------------------

interface WebpChunk {
  type: string;
  data: number;
  size: number;
}

/** The chunks between `from` and `end`, each padded to an even size. */
function webpChunks(b: Uint8Array, from: number, end: number): WebpChunk[] {
  const chunks: WebpChunk[] = [];
  let at = from;
  while (at < end) {
    if (at + 8 > end) refuse('container');
    const type = ascii(b, at, at + 4);
    const size = u32le(b, at + 4);
    const data = at + 8;
    const next = data + size + (size & 1);
    if (next > end) refuse('container');
    chunks.push({ type, data, size });
    at = next;
  }
  return chunks;
}

/** The size a VP8 or VP8L bitstream declares, or null for any other chunk. */
function bitstreamSize(b: Uint8Array, chunk: WebpChunk): { width: number; height: number } | null {
  if (chunk.type === 'VP8 ') {
    const d = chunk.data;
    // A key frame: its tag's low bit is 0, then the start code.
    if (chunk.size < 10 || ((b[d] ?? 1) & 1) !== 0) refuse('container');
    if (b[d + 3] !== 0x9d || b[d + 4] !== 0x01 || b[d + 5] !== 0x2a) refuse('container');
    return { width: u16le(b, d + 6) & 0x3fff, height: u16le(b, d + 8) & 0x3fff };
  }
  if (chunk.type === 'VP8L') {
    const d = chunk.data;
    if (chunk.size < 5 || b[d] !== 0x2f) refuse('container');
    const bits = u32le(b, d + 1);
    // The version, the top 3 bits, is 0.
    if (bits >= 0x20000000) refuse('container');
    return { width: (bits & 0x3fff) + 1, height: (Math.floor(bits / 0x4000) % 0x4000) + 1 };
  }
  return null;
}

/** The size of the one image bitstream among `chunks`, which must be there. */
function oneBitstream(b: Uint8Array, chunks: WebpChunk[]): { width: number; height: number } {
  const sizes = chunks.map((c) => bitstreamSize(b, c)).filter((s) => s !== null);
  if (sizes.length !== 1 || !sizes[0]) refuse('container');
  return sizes[0];
}

function webp(b: Uint8Array): Size {
  const end = 8 + u32le(b, 4);
  if (end < 12 || end > b.length) refuse('container');
  const chunks = webpChunks(b, 12, end);
  const first = chunks[0];
  if (!first) refuse('container');
  if (first.type !== 'VP8X') {
    if (chunks.length !== 1 && chunks.some((c, i) => i > 0 && bitstreamSize(b, c))) {
      refuse('container');
    }
    const size = bitstreamSize(b, first);
    if (!size) refuse('container');
    checkCanvas(size.width, size.height);
    return { ...size, frames: 1 };
  }
  if (first.size < 10) refuse('container');
  const animated = ((b[first.data] ?? 0) & 0x02) !== 0;
  const canvas = { width: u24le(b, first.data + 4) + 1, height: u24le(b, first.data + 7) + 1 };
  checkCanvas(canvas.width, canvas.height);
  const rest = chunks.slice(1);
  if (rest.some((c) => c.type === 'VP8X')) refuse('container');
  if (!animated) {
    if (rest.some((c) => c.type === 'ANMF')) refuse('container');
    const size = oneBitstream(b, rest);
    if (size.width !== canvas.width || size.height !== canvas.height) refuse('container');
    return { ...canvas, frames: 1 };
  }
  if (!rest.some((c) => c.type === 'ANIM') || rest.some((c) => bitstreamSize(b, c))) {
    refuse('container');
  }
  let frames = 0;
  for (const chunk of rest) {
    if (chunk.type !== 'ANMF') continue;
    frames = countFrame(frames);
    const d = chunk.data;
    if (chunk.size < 16) refuse('container');
    const frame = {
      x: 2 * u24le(b, d),
      y: 2 * u24le(b, d + 3),
      width: u24le(b, d + 6) + 1,
      height: u24le(b, d + 9) + 1,
    };
    checkFrame(canvas, frame.x, frame.y, frame.width, frame.height);
    const size = oneBitstream(b, webpChunks(b, d + 16, d + chunk.size));
    if (size.width !== frame.width || size.height !== frame.height) refuse('container');
  }
  if (frames === 0) refuse('container');
  return { ...canvas, frames };
}

// --- JPEG ---------------------------------------------------------------------

const isStartOfFrame = (m: number): boolean =>
  m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

/** Skips entropy-coded data; returns the offset of the marker that ends it. */
function entropyEnd(b: Uint8Array, from: number): number {
  let at = from;
  for (;;) {
    at = b.indexOf(0xff, at);
    if (at < 0 || at + 1 >= b.length) refuse('container');
    const next = b[at + 1] ?? 0;
    // A stuffed zero byte or a restart marker belongs to the data.
    if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) at += 2;
    else return at;
  }
}

function jpeg(b: Uint8Array): Size {
  let at = 2;
  let size: { width: number; height: number } | null = null;
  let scans = 0;
  for (;;) {
    if (at >= b.length || b[at] !== 0xff) refuse('container');
    while (at < b.length && b[at] === 0xff) at += 1;
    if (at >= b.length) refuse('container');
    const marker = b[at] ?? 0;
    at += 1;
    if (marker === 0xd9) break;
    if (marker === 0xd8 || marker === 0x00) refuse('container');
    // Markers without a length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (at + 2 > b.length) refuse('container');
    const length = u16be(b, at);
    if (length < 2 || at + length > b.length) refuse('container');
    if (isStartOfFrame(marker)) {
      if (size || length < 8) refuse('container');
      size = { height: u16be(b, at + 3), width: u16be(b, at + 5) };
      checkCanvas(size.width, size.height);
    } else if (marker === 0xda) {
      if (!size) refuse('container');
      scans += 1;
      if (scans > MAX_JPEG_SCANS) refuse('frames');
      at = entropyEnd(b, at + length);
      continue;
    }
    at += length;
  }
  if (!size || scans === 0) refuse('container');
  return { ...size, frames: 1 };
}

const READERS: Record<RasterFormat, (b: Uint8Array) => Size> = { png, jpeg, gif, webp };

/** Checks an image's bytes. Pure: the same bytes give the same answer everywhere. */
export function checkRaster(bytes: Uint8Array): RasterCheck {
  const format = rasterFormat(bytes);
  if (!format) return { ok: false, reason: 'format' };
  try {
    const { width, height, frames } = READERS[format](bytes);
    const pixels = frames * width * height;
    if (pixels > MAX_TOTAL_PIXELS) return { ok: false, reason: 'pixels' };
    return {
      ok: true,
      image: { format, contentType: RASTER_CONTENT_TYPES[format], width, height, frames, pixels },
    };
  } catch (err) {
    if (err instanceof Refused) return { ok: false, reason: err.reason };
    throw err;
  }
}
