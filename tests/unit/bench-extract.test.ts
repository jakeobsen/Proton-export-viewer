// SPDX-License-Identifier: AGPL-3.0-or-later
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  Base64Decoder,
  QuotedPrintableDecoder,
  extractText,
} from '../../src/testhooks/bench/extract';
import { BODY_STATE } from '../../src/testhooks/bench/schema';
import { largeMessage } from '../../tools/gen-export/stream.mjs';

/** The message as a stream of chunks of `size` bytes, to cross every boundary. */
function chunked(text: string | Buffer, size: number): Readable {
  const buf = typeof text === 'string' ? Buffer.from(text) : text;
  const parts: Buffer[] = [];
  for (let i = 0; i < buf.length; i += size) parts.push(buf.subarray(i, i + size));
  return Readable.from(parts, { objectMode: false });
}

const crlf = (lines: string[]) => lines.join('\r\n');

describe('streaming transfer decoders', () => {
  it('decode base64 split anywhere, with line breaks', () => {
    const encoded = Buffer.from('héllo wörld, once more'.repeat(20)).toString('base64');
    const wrapped = encoded.replace(/(.{76})/g, '$1\r\n');
    for (const size of [1, 3, 7, 77]) {
      const d = new Base64Decoder();
      const out: Buffer[] = [];
      for (let i = 0; i < wrapped.length; i += size)
        out.push(d.write(Buffer.from(wrapped.slice(i, i + size))));
      out.push(d.end());
      expect(Buffer.concat(out).toString()).toBe('héllo wörld, once more'.repeat(20));
    }
  });

  it('decode quoted-printable with escapes and soft breaks split anywhere', () => {
    const qp = 'caf=C3=A9 au lait=\r\n continues =3D here=\r\nend';
    for (const size of [1, 2, 3, 5]) {
      const d = new QuotedPrintableDecoder();
      const out: Buffer[] = [];
      for (let i = 0; i < qp.length; i += size)
        out.push(d.write(Buffer.from(qp.slice(i, i + size), 'latin1')));
      out.push(d.end());
      expect(Buffer.concat(out).toString('utf8')).toBe('café au lait continues = hereend');
    }
  });
});

describe('extractText', () => {
  const alternative = crlf([
    'Subject: t',
    'Content-Type: multipart/alternative; boundary="b"',
    '',
    '--b',
    'Content-Type: text/plain; charset=iso-8859-1',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Caf=E9 plain version',
    '--b',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>html version</p>',
    '--b--',
    '',
  ]);

  it('indexes one alternative, decoding the charset, at any chunk size', async () => {
    for (const size of [1, 13, 4096]) {
      const r = await extractText(chunked(alternative, size));
      expect(r.text).toContain('Café plain version');
      expect(r.text).not.toContain('html version');
      expect(r.state).toBe(BODY_STATE.indexed);
      expect(r.inputBytes).toBe(Buffer.byteLength(alternative));
    }
  });

  it('turns HTML into text without scripts, styles or entities', async () => {
    const html = crlf([
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(
        '<html><head><title>T</title><style>p{color:red}</style></head><body><p>Fish &amp; chips</p><script>steal()</script><div>tail</div></body></html>',
      )
        .toString('base64')
        .replace(/(.{76})/g, '$1\r\n'),
      '',
    ]);
    const r = await extractText(chunked(html, 5));
    expect(r.text).toContain('Fish & chips');
    expect(r.text).toContain('tail');
    expect(r.text).not.toMatch(/steal|color|T\n/);
  });

  it('drains attachments without indexing them and removes marker characters', async () => {
    const mixed = crlf([
      'Content-Type: multipart/mixed; boundary="m"',
      '',
      '--m',
      'Content-Type: text/plain',
      '',
      'see attached',
      '--m',
      'Content-Type: text/plain; name="notes.txt"',
      'Content-Disposition: attachment; filename="notes.txt"',
      '',
      'secret attachment words',
      '--m--',
      '',
    ]);
    const r = await extractText(chunked(mixed, 7));
    expect(r.text.trim()).toBe('see attached');
    expect(r.textParts).toBe(1);
  });

  it('stops at the raw text ceiling and marks the body truncated', async () => {
    const msg = largeMessage({ kind: 'text', bytes: 256 * 1024, seed: 3 });
    const r = await extractText(msg, { rawText: 64 * 1024, storedText: 1024 * 1024 });
    expect(r.rawTextBytes).toBe(64 * 1024);
    expect(r.state).toBe(BODY_STATE.truncated);
    expect(r.inputBytes).toBeGreaterThan(256 * 1024);
  });

  it('stops at the stored text ceiling without splitting a character', async () => {
    const body = 'ünïcödé '.repeat(5000);
    const msg = crlf(['Content-Type: text/plain; charset=utf-8', '', body, '']);
    const r = await extractText(chunked(msg, 1000), {
      rawText: 16 * 1024 * 1024,
      storedText: 1001,
    });
    expect(r.textBytes).toBeLessThanOrEqual(1001);
    expect(r.textBytes).toBeGreaterThan(990);
    expect(r.text).not.toContain('�');
    expect(r.state).toBe(BODY_STATE.truncated);
  });

  it('handles an HTML part that ends inside a tag', async () => {
    const msg = largeMessage({ kind: 'html', bytes: 100_003, seed: 2 });
    const r = await extractText(msg);
    expect(r.state).toBe(BODY_STATE.indexed);
    expect(r.rawTextBytes).toBeGreaterThanOrEqual(100_003);
    expect(r.text.length).toBeGreaterThan(1000);
    expect(r.text).not.toContain('<p>');
  });
});
