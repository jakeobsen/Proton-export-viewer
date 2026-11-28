// SPDX-License-Identifier: AGPL-3.0-or-later
// Images built byte by byte, for the generated exports and the tests: valid
// ones that decode to a solid colour, and ones that only declare what a
// decoder would make of them (sizes, frames, scans), with no pixel data
// behind it. Nothing here depends on an image or compression library.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(buffer) {
  let a = 1;
  let b = 0;
  for (const byte of buffer) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A zlib stream of stored (uncompressed) blocks, so its bytes never depend on a zlib version. */
export function storedZlib(data) {
  const blocks = [Buffer.from([0x78, 0x01])];
  let at = 0;
  do {
    const size = Math.min(65535, data.length - at);
    const head = Buffer.alloc(5);
    head[0] = at + size >= data.length ? 1 : 0;
    head.writeUInt16LE(size, 1);
    head.writeUInt16LE(~size & 0xffff, 3);
    blocks.push(head, data.subarray(at, at + size));
    at += size;
  } while (at < data.length);
  const adler = Buffer.alloc(4);
  adler.writeUInt32BE(adler32(data), 0);
  blocks.push(adler);
  return Buffer.concat(blocks);
}

function ihdr(width, height, bitDepth, colorType) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data.set([bitDepth, colorType, 0, 0, 0], 8);
  return pngChunk('IHDR', data);
}

/** A valid width x height PNG of one colour, `rgb` = [r, g, b]. */
export function solidPng(width, height, rgb) {
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  const rows = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    PNG_SIGNATURE,
    ihdr(width, height, 8, 2),
    pngChunk('IDAT', storedZlib(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A 1-bit grayscale PNG that declares width x height pixels but carries one
 * row of image data.
 */
export function dimensionBombPng(width, height) {
  const row = Buffer.alloc(1 + Math.ceil(width / 8));
  return Buffer.concat([
    PNG_SIGNATURE,
    ihdr(width, height, 1, 0),
    pngChunk('IDAT', storedZlib(row)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A PNG of `bytes` bytes or a little more: a valid 1x1 image whose size comes
 * from a private ancillary chunk of zeros, which decoders skip.
 */
export function paddedPng(bytes) {
  const head = Buffer.concat([PNG_SIGNATURE, ihdr(1, 1, 1, 0)]);
  const tail = Buffer.concat([
    pngChunk('IDAT', storedZlib(Buffer.from([0, 0]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  const pad = Math.max(0, bytes - head.length - tail.length - 12);
  return Buffer.concat([head, pngChunk('prVt', Buffer.alloc(pad)), tail]);
}

/**
 * An APNG: a width x height canvas whose `acTL` declares `declared` frames
 * (default: `frames`), with `frames` `fcTL` chunks of 1x1 frames at (0, 0).
 * `rect` = {x, y, width, height} replaces the last frame's rectangle. The
 * first frame is the default image unless `separateDefault` is set.
 */
export function apng(width, height, frames, options = {}) {
  const declared = options.declared ?? frames;
  const parts = [PNG_SIGNATURE, ihdr(width, height, 1, 0)];
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(declared, 0);
  parts.push(pngChunk('acTL', actl));
  const image = storedZlib(Buffer.from([0, 0]));
  let sequence = 0;
  const control = (i) => {
    const last = i === frames - 1 && options.rect;
    const rect = last ? options.rect : { x: 0, y: 0, width: 1, height: 1 };
    const data = Buffer.alloc(26);
    data.writeUInt32BE(sequence++, 0);
    data.writeUInt32BE(rect.width, 4);
    data.writeUInt32BE(rect.height, 8);
    data.writeUInt32BE(rect.x, 12);
    data.writeUInt32BE(rect.y, 16);
    data.writeUInt16BE(1, 20);
    data.writeUInt16BE(10, 22);
    return pngChunk('fcTL', data);
  };
  if (options.separateDefault) parts.push(pngChunk('IDAT', image));
  for (let i = 0; i < frames; i++) {
    parts.push(control(i));
    if (i === 0 && !options.separateDefault) {
      parts.push(pngChunk('IDAT', image));
    } else {
      const seq = Buffer.alloc(4);
      seq.writeUInt32BE(sequence++, 0);
      parts.push(pngChunk('fdAT', Buffer.concat([seq, image])));
    }
  }
  parts.push(pngChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/** GIF data sub-blocks of at most 255 bytes, with the terminator. */
function subBlocks(data) {
  const parts = [];
  for (let at = 0; at < data.length; at += 255) {
    const piece = data.subarray(at, at + 255);
    parts.push(Buffer.from([piece.length]), piece);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

/**
 * LZW image data for `pixels` pixels of colour index 0, with a minimum code
 * size of 2. A clear code after every two pixels keeps every code 3 bits.
 */
function lzwZeros(pixels) {
  const codes = [];
  for (let i = 0; i < pixels; i += 2) codes.push(4, ...(i + 1 < pixels ? [0, 0] : [0]));
  codes.push(5);
  const out = [];
  let acc = 0;
  let bits = 0;
  for (const code of codes) {
    acc |= code << bits;
    bits += 3;
    while (bits >= 8) {
      out.push(acc & 0xff);
      acc >>= 8;
      bits -= 8;
    }
  }
  if (bits > 0) out.push(acc & 0xff);
  return Buffer.from(out);
}

/**
 * A GIF of a width x height canvas and `frames` frames of colour `rgb`.
 * Each frame is 1x1 at (0, 0) unless `full` is set, which makes it fill the
 * canvas; `rect` = {x, y, width, height} replaces the last frame's
 * rectangle (its image data then still holds one pixel).
 */
export function gifImage(width, height, frames, options = {}) {
  const rgb = options.rgb ?? [0, 0, 0];
  const screen = Buffer.alloc(7);
  screen.writeUInt16LE(width, 0);
  screen.writeUInt16LE(height, 2);
  // A global colour table of 4 entries: the colour, then white.
  screen.set([0x81, 0, 0], 4);
  const parts = [
    Buffer.from('GIF89a', 'ascii'),
    screen,
    Buffer.from([...rgb, 255, 255, 255, 255, 255, 255, 255, 255, 255]),
  ];
  if (frames > 1) {
    parts.push(Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0'), 3, 1, 0, 0, 0]));
  }
  for (let i = 0; i < frames; i++) {
    const last = i === frames - 1 && options.rect;
    const rect = last
      ? options.rect
      : options.full
        ? { x: 0, y: 0, width, height }
        : { x: 0, y: 0, width: 1, height: 1 };
    const descriptor = Buffer.alloc(10);
    descriptor[0] = 0x2c;
    descriptor.writeUInt16LE(rect.x, 1);
    descriptor.writeUInt16LE(rect.y, 3);
    descriptor.writeUInt16LE(rect.width, 5);
    descriptor.writeUInt16LE(rect.height, 7);
    parts.push(
      Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00]),
      descriptor,
      Buffer.from([2]),
      subBlocks(lzwZeros(last ? 1 : rect.width * rect.height)),
    );
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

/** An animated GIF: a width x height canvas and `frames` 1x1 black frames. */
export function gif(width, height, frames) {
  const parts = [Buffer.from('GIF89a', 'ascii')];
  const screen = Buffer.alloc(7);
  screen.writeUInt16LE(width, 0);
  screen.writeUInt16LE(height, 2);
  screen.set([0x80, 0, 0], 4);
  parts.push(screen, Buffer.from([0, 0, 0, 255, 255, 255]));
  parts.push(Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0'), 3, 1, 0, 0, 0]));
  const frame = Buffer.from([
    0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0x02, 0x02,
    0x44, 0x01, 0x00,
  ]);
  for (let i = 0; i < frames; i++) parts.push(frame);
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

function riff(chunks) {
  const body = Buffer.concat([Buffer.from('WEBP', 'ascii'), ...chunks]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

function webpChunk(type, data) {
  const head = Buffer.alloc(8);
  head.write(type, 0, 'ascii');
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function u24(value) {
  const out = Buffer.alloc(3);
  out.writeUIntLE(value, 0, 3);
  return out;
}

/** A VP8L chunk that declares width x height; its bitstream stops after the header. */
function vp8l(width, height) {
  const data = Buffer.alloc(8);
  data[0] = 0x2f;
  data.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 1);
  return webpChunk('VP8L', data);
}

/** A VP8 key-frame chunk that declares width x height. */
function vp8(width, height) {
  const data = Buffer.alloc(10);
  data.set([0x10, 0x00, 0x00, 0x9d, 0x01, 0x2a], 0);
  data.writeUInt16LE(width, 6);
  data.writeUInt16LE(height, 8);
  return webpChunk('VP8 ', data);
}

/** A still WebP (simple format) that declares width x height. */
export function webpImage(width, height, options = {}) {
  return riff([options.lossy ? vp8(width, height) : vp8l(width, height)]);
}

/**
 * An animated WebP: a width x height canvas (VP8X), ANIM, and `frames` ANMF
 * frames of 1x1 at (0, 0). `rect` = {x, y, width, height} replaces the last
 * frame's rectangle (x and y even), and `bitstream` = {width, height} the
 * size its image data declares. `still` writes the VP8X flags without the
 * animation bit.
 */
export function webpAnimated(width, height, frames, options = {}) {
  const vp8x = Buffer.alloc(10);
  vp8x[0] = options.still ? 0 : 0x02;
  vp8x.set(u24(width - 1), 4);
  vp8x.set(u24(height - 1), 7);
  const chunks = [webpChunk('VP8X', vp8x), webpChunk('ANIM', Buffer.alloc(6))];
  for (let i = 0; i < frames; i++) {
    const last = i === frames - 1 && options.rect;
    const rect = last ? options.rect : { x: 0, y: 0, width: 1, height: 1 };
    const head = Buffer.concat([
      u24(rect.x / 2),
      u24(rect.y / 2),
      u24(rect.width - 1),
      u24(rect.height - 1),
      u24(10),
      Buffer.from([0]),
    ]);
    const size = (last && options.bitstream) || rect;
    chunks.push(webpChunk('ANMF', Buffer.concat([head, vp8l(size.width, size.height)])));
  }
  return riff(chunks);
}

/** A baseline or progressive JPEG header that declares width x height, with `scans` scans. */
export function jpegImage(width, height, options = {}) {
  const scans = options.scans ?? 1;
  const segment = (marker, data) => {
    const head = Buffer.from([0xff, marker, 0, 0]);
    head.writeUInt16BE(data.length + 2, 2);
    return Buffer.concat([head, data]);
  };
  const sof = Buffer.alloc(9);
  sof[0] = 8;
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  sof.set([1, 1, 0x11, 0], 5);
  const parts = [Buffer.from([0xff, 0xd8]), segment(scans > 1 ? 0xc2 : 0xc0, sof)];
  for (let i = 0; i < scans; i++) {
    parts.push(
      segment(0xda, Buffer.from([1, 1, 0x00, 0, 63, 0])),
      // Entropy-coded data, with a stuffed 0xff and a restart marker.
      Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78]),
    );
  }
  parts.push(Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}
