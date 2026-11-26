// SPDX-License-Identifier: AGPL-3.0-or-later
// Very large messages, generated as streams while a test runs and never
// stored: the 10 MB and 50 MB messages of a large mailbox, and the 200 MB
// text and HTML parts of the hostile set. The same options always give the
// same bytes.

import { Readable } from 'node:stream';
import { Random } from './random.mjs';
import { base64Lines, rfcDate, sentence } from './text.mjs';

const CHUNK = 64 * 1024;

/**
 * A complete .eml whose single large part (`kind`: "text", "html" or
 * "attachment") has `bytes` bytes of encoded content.
 *
 * @param {{kind: 'text' | 'html' | 'attachment', bytes: number, seed?: number}} options
 * @returns {Readable}
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

  function* chunks() {
    yield Buffer.from(prefix);
    let left = bytes;
    while (left > 0) {
      let piece;
      if (kind === 'attachment') {
        // 57 raw bytes make one 76-character base64 line.
        const lines = Math.max(1, Math.floor(CHUNK / 78));
        piece = Buffer.from(`${base64Lines(rng.bytes(lines * 57))}\r\n`);
      } else {
        const parts = [];
        let size = 0;
        while (size < CHUNK) {
          const line = kind === 'html' ? `<p>${sentence(rng)}</p>` : sentence(rng);
          parts.push(line);
          size += line.length + 2;
        }
        piece = Buffer.from(`${parts.join('\r\n')}\r\n`);
      }
      if (piece.length > left) piece = piece.subarray(0, left);
      left -= piece.length;
      yield piece;
    }
    yield Buffer.from(suffix);
  }
  return Readable.from(chunks(), { objectMode: false });
}
