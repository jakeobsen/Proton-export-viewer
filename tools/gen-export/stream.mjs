// SPDX-License-Identifier: AGPL-3.0-or-later
// Very large messages, generated as streams while a test runs and never
// stored: the 10 MB and 50 MB messages of a large mailbox, and the 200 MB
// text and HTML parts of the hostile set. The same options always give the
// same bytes.

import { Readable } from 'node:stream';
import { Random } from './random.mjs';
import { base64Lines, rfcDate, sentence } from './text.mjs';

const CHUNK = 64 * 1024;

/** A base64 line: 57 bytes make 76 characters, plus CRLF. */
const LINE_RAW = 57;
const LINE_BYTES = 78;

/**
 * The size of an attachment part of at most `bytes` bytes that ends on a
 * whole base64 line: full 76-character lines, then one shorter line of whole
 * 4-character groups, each line with its CRLF. At most 5 bytes below `bytes`.
 */
export function attachmentPartBytes(bytes) {
  const full = Math.floor(bytes / LINE_BYTES);
  const rest = bytes - full * LINE_BYTES;
  const last = rest >= 6 ? Math.floor((rest - 2) / 4) * 4 + 2 : 0;
  return full * LINE_BYTES + last;
}

/**
 * A complete .eml whose single large part (`kind`: "text", "html" or
 * "attachment") has `bytes` bytes of encoded content. A text or HTML part
 * has exactly `bytes`; an attachment ends on whole base64 groups and lines,
 * so it has attachmentPartBytes(bytes). The stream's `partBytes` is the
 * part's size.
 *
 * @param {{kind: 'text' | 'html' | 'attachment', bytes: number, seed?: number}} options
 * @returns {Readable & {partBytes: number}}
 */
export function largeMessage({ kind, bytes, seed = 1 }) {
  if (!['text', 'html', 'attachment'].includes(kind)) throw new Error(`unknown kind ${kind}`);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('bytes must be a whole number');
  const rng = new Random(`large/${kind}/${bytes}/${seed}`);
  const boundary = `=_large_${seed}`;
  const head = [
    `Date: ${rfcDate(Date.UTC(2024, 5, 1) / 1000)}`,
    'From: Large Sender <large@example.org>',
    'To: <owner@example.com>',
    `Subject: Large ${kind} message`,
    `Message-ID: <large.${kind}.${bytes}.${seed}@example.org>`,
    'MIME-Version: 1.0',
  ];
  let prefix;
  let suffix;
  if (kind === 'attachment') {
    prefix = [
      ...head,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      'The attachment is large.',
      `--${boundary}`,
      'Content-Type: application/octet-stream; name="large.bin"',
      'Content-Disposition: attachment; filename="large.bin"',
      'Content-Transfer-Encoding: base64',
      '',
      '',
    ].join('\r\n');
    suffix = `\r\n--${boundary}--\r\n`;
  } else if (kind === 'html') {
    prefix = [...head, 'Content-Type: text/html; charset=utf-8', '', '<html><body>'].join('\r\n');
    suffix = '\r\n</body></html>\r\n';
  } else {
    prefix = [...head, 'Content-Type: text/plain; charset=utf-8', '', ''].join('\r\n');
    suffix = '\r\n';
  }

  function* attachment() {
    const part = attachmentPartBytes(bytes);
    let lines = Math.floor(part / LINE_BYTES);
    const perChunk = Math.floor(CHUNK / LINE_BYTES);
    while (lines > 0) {
      const n = Math.min(perChunk, lines);
      yield Buffer.from(`${base64Lines(rng.bytes(n * LINE_RAW))}\r\n`);
      lines -= n;
    }
    // The last, shorter line: whole 4-character groups of 3 bytes each.
    const last = part % LINE_BYTES;
    if (last > 0) yield Buffer.from(`${rng.bytes(((last - 2) / 4) * 3).toString('base64')}\r\n`);
  }

  function* text() {
    let left = bytes;
    while (left > 0) {
      const parts = [];
      let size = 0;
      while (size < CHUNK) {
        const line = kind === 'html' ? `<p>${sentence(rng)}</p>` : sentence(rng);
        parts.push(line);
        size += line.length + 2;
      }
      let piece = Buffer.from(`${parts.join('\r\n')}\r\n`);
      if (piece.length > left) piece = piece.subarray(0, left);
      left -= piece.length;
      yield piece;
    }
  }

  function* chunks() {
    yield Buffer.from(prefix);
    yield* kind === 'attachment' ? attachment() : text();
    yield Buffer.from(suffix);
  }
  const stream = Readable.from(chunks(), { objectMode: false });
  return Object.assign(stream, {
    partBytes: kind === 'attachment' ? attachmentPartBytes(bytes) : bytes,
  });
}
