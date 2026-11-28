// SPDX-License-Identifier: AGPL-3.0-or-later
// What the source view reads from a message in the reader worker: the raw
// header block without a parse, the structure in the reader's numbering with
// decoded sizes, and one part's raw header block.

import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  messageHeaderBlock,
  messageStructure,
  partHeaderBlock,
  SOURCE_HEADER_BYTES,
} from '../../src/core/reader/source-view';
import { MAX_MIME_PARTS } from '../../src/core/mime-limits';
import { extractMessage } from '../../src/core/reader/extract';
import { cleanFilename } from '../../src/shared/filename';
import { bodiesAround } from '../mime-parts';

const crlf = (lines: string[]) => lines.join('\r\n');
/** A stream of `bytes`, in chunks of `size` bytes, as a file read gives it. */
const stream = (bytes: Buffer | string, size = 65536) => {
  const all = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8');
  const chunks: Buffer[] = [];
  for (let i = 0; i < all.length; i += size) chunks.push(all.subarray(i, i + size));
  return Readable.from(chunks.length > 0 ? chunks : [Buffer.alloc(0)]);
};

const NESTED = crlf([
  'From: a@example.com',
  'Subject: nested',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="mx"',
  '',
  '--mx',
  'Content-Type: multipart/related; boundary="rel"',
  '',
  '--rel',
  'Content-Type: multipart/alternative; boundary="alt"',
  '',
  '--alt',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'caf=C3=A9',
  '--alt',
  'Content-Type: text/html; charset=UTF-8',
  '',
  '<p>hello</p>',
  '--alt--',
  '--rel',
  'Content-Type: image/png',
  'Content-Transfer-Encoding: base64',
  'Content-Disposition: inline',
  'Content-ID: <logo@example.com>',
  '',
  Buffer.from('0123456789').toString('base64'),
  '--rel--',
  '--mx',
  'Content-Type: application/pdf; name="order.pdf"',
  'Content-Transfer-Encoding: base64',
  'Content-Disposition: attachment; filename="../order\u202e.pdf"',
  '',
  Buffer.alloc(3000, 7).toString('base64').replace(/.{76}/g, '$&\r\n'),
  '--mx',
  'Content-Type: message/rfc822',
  '',
  'Subject: inner',
  'Content-Type: multipart/mixed; boundary="in"',
  '',
  '--in',
  'Content-Type: text/plain',
  '',
  'inner text',
  '--in--',
  '--mx--',
  '',
]);

describe('messageHeaderBlock', () => {
  it('is the bytes up to the first empty line, CRLF or LF, kept as they are', async () => {
    const head = 'From: a@example.com\r\nX-Folded: one\r\n\ttwo\x01\x7f\r\nSubject: s\r\n';
    expect(await messageHeaderBlock(stream(`${head}\r\nbody\r\n`))).toEqual({
      bytes: Buffer.from(head),
      truncated: false,
    });
    const lf = 'From: a@example.com\nSubject: s\n';
    expect(await messageHeaderBlock(stream(`${lf}\nbody\n`))).toEqual({
      bytes: Buffer.from(lf),
      truncated: false,
    });
  });

  it('finds the end across chunk edges', async () => {
    const head = 'From: a@example.com\r\nSubject: s\r\n';
    for (const size of [1, 2, 3, 7]) {
      const block = await messageHeaderBlock(stream(`${head}\r\nbody`, size));
      expect(block).toEqual({ bytes: Buffer.from(head), truncated: false });
    }
  });

  it('is everything for a message with no empty line, and nothing for one that starts with it', async () => {
    expect(await messageHeaderBlock(stream('Subject: only\r\n'))).toEqual({
      bytes: Buffer.from('Subject: only\r\n'),
      truncated: false,
    });
    expect((await messageHeaderBlock(stream('\r\nbody'))).bytes.length).toBe(0);
    expect((await messageHeaderBlock(stream('\nbody'))).bytes.length).toBe(0);
    expect((await messageHeaderBlock(stream(''))).bytes.length).toBe(0);
  });

  it('is cut at 256 KB, and says so', async () => {
    const long = `X-Long: ${'a'.repeat(SOURCE_HEADER_BYTES)}\r\n`;
    const cut = await messageHeaderBlock(stream(`${long}\r\nbody`));
    expect(cut.truncated).toBe(true);
    expect(cut.bytes.length).toBe(SOURCE_HEADER_BYTES);
    expect(cut.bytes.subarray(0, 8).toString()).toBe('X-Long: ');
    // A block of exactly the cap is whole.
    const exact = `X-E: ${'b'.repeat(SOURCE_HEADER_BYTES - 7)}\r\n`;
    expect(exact.length).toBe(SOURCE_HEADER_BYTES);
    expect(await messageHeaderBlock(stream(`${exact}\r\nbody`))).toEqual({
      bytes: Buffer.from(exact),
      truncated: false,
    });
  });

  it('is cut at 256 KB when the block goes on past it, without reading to its end', async () => {
    let pulled = 0;
    const body = new Readable({
      highWaterMark: 1,
      read() {
        pulled += 1;
        this.push(pulled === 1 ? Buffer.from('X-Long: ') : Buffer.alloc(65536, 0x61));
      },
    });
    const cut = await messageHeaderBlock(body);
    expect(cut.truncated).toBe(true);
    expect(cut.bytes.length).toBe(SOURCE_HEADER_BYTES);
    // 4 × 64 KiB after the field name is past the cap: one more chunk at most.
    expect(pulled).toBeLessThanOrEqual(7);
  });

  it('stops reading once it has the block', async () => {
    let pulled = 0;
    const body = new Readable({
      highWaterMark: 1,
      read() {
        pulled += 1;
        this.push(pulled === 1 ? Buffer.from('Subject: s\r\n\r\n') : Buffer.alloc(65536, 0x61));
      },
    });
    await messageHeaderBlock(body);
    expect(pulled).toBeLessThanOrEqual(3);
  });
});

describe('messageStructure', () => {
  it('lists every part in the reader numbering, leaves with decoded sizes, containers adding up', async () => {
    const parts = await messageStructure(stream(NESTED));
    expect(parts.map((p) => [p.path, p.parent, p.contentType])).toEqual([
      ['1', -1, 'multipart/mixed'],
      ['1.1', 0, 'multipart/related'],
      ['1.1.1', 1, 'multipart/alternative'],
      ['1.1.1.1', 2, 'text/plain'],
      ['1.1.1.2', 2, 'text/html'],
      ['1.1.2', 1, 'image/png'],
      ['1.2', 0, 'application/pdf'],
      // An attached message is one part, not split.
      ['1.3', 0, 'message/rfc822'],
    ]);
    const byPath = new Map(parts.map((p) => [p.path, p]));
    expect(byPath.get('1.1.1.1')).toMatchObject({ charset: 'utf-8', size: 5, name: '' });
    expect(byPath.get('1.1.1.2')).toMatchObject({ charset: 'UTF-8', size: 12 });
    expect(byPath.get('1.1.2')).toMatchObject({ inline: true, size: 10 });
    // The name is cleaned as the attachment list cleans it.
    expect(byPath.get('1.2')).toMatchObject({
      inline: false,
      size: 3000,
      name: cleanFilename('../order\u202e.pdf'),
    });
    expect(byPath.get('1.2')!.name).not.toMatch(/[/\u202e]/u);
    expect(byPath.get('1.1.1')!.size).toBe(5 + 12);
    expect(byPath.get('1.1')!.size).toBe(5 + 12 + 10);
    const leaves = parts.filter((p) => !p.contentType.startsWith('multipart/'));
    expect(byPath.get('1')!.size).toBe(leaves.reduce((sum, p) => sum + p.size, 0));
    expect(parts.every((p) => !p.cut)).toBe(true);
  });

  it('gives a single-part message as one part', async () => {
    const parts = await messageStructure(
      stream(crlf(['Subject: s', 'Content-Type: text/plain; charset=us-ascii', '', 'hello', ''])),
    );
    expect(parts).toEqual([
      {
        path: '1',
        parent: -1,
        contentType: 'text/plain',
        charset: 'us-ascii',
        name: '',
        inline: false,
        size: 7,
        cut: false,
      },
    ]);
  });
});

describe('messageStructure past the part limits', () => {
  it('stops where the reader stops: the same parts, and the containers still open are cut', async () => {
    const eml = bodiesAround(MAX_MIME_PARTS + 10);
    const parts = await messageStructure(stream(eml));
    const reader = await extractMessage(stream(eml));
    expect(reader.stopped).toBe(true);
    expect(parts.map((p) => p.path)).toEqual(reader.tree.parts.map((p) => p.path));
    // The message's own multipart was open; its alternative had ended.
    expect(parts.filter((p) => p.cut).map((p) => p.path)).toEqual(['1']);
    expect(parts[1]).toMatchObject({ contentType: 'multipart/alternative', cut: false });
    expect(parts.slice(4).every((p) => p.size === 1)).toBe(true);
    expect(parts[0]!.size).toBe(parts.slice(2).reduce((sum, p) => sum + p.size, 0));
  });

  it('cuts every container open at a header block over the limit, and no leaf', async () => {
    const eml = crlf([
      'Subject: Long header',
      'Content-Type: multipart/mixed; boundary="m"',
      '',
      '--m',
      'Content-Type: text/plain',
      '',
      'First.',
      '--m',
      'Content-Type: multipart/mixed; boundary="n"',
      '',
      '--n',
      'Content-Type: text/plain',
      '',
      'Inner.',
      '--n',
      'Content-Type: text/plain',
      `X-Long: ${'h'.repeat(3 * 1024 * 1024)}`,
      '',
      'After it.',
      '--n--',
      '--m--',
      '',
    ]);
    const parts = await messageStructure(stream(eml));
    expect(parts.map((p) => [p.path, p.cut, p.size])).toEqual([
      ['1', true, 12],
      ['1.1', false, 6],
      ['1.2', true, 6],
      ['1.2.1', false, 6],
    ]);
  });
});

describe('partHeaderBlock', () => {
  const FOLDED = crlf([
    'Subject: s',
    'Content-Type: multipart/mixed; boundary="b"',
    '',
    '--b',
    'Content-Type: text/plain',
    '',
    'one',
    '--b',
    'Content-Type: application/octet-stream;\r\n name="xé.bin"',
    'X-Odd: a\x01b\x7f\x1b[31m',
    '\tfolded on',
    '',
    'two',
    '--b--',
    '',
  ]);

  it("gives a part's header block as the splitter read it, byte for byte", async () => {
    const block = await partHeaderBlock(stream(FOLDED), '1.2');
    expect(block?.truncated).toBe(false);
    const text = block!.bytes.toString('utf8');
    expect(text).toContain('Content-Type: application/octet-stream;\r\n name="xé.bin"\r\n');
    expect(text).toContain('X-Odd: a\x01b\x7f\x1b[31m\r\n\tfolded on');
    expect(text).not.toContain('Content-Type: text/plain');
  });

  it('finds a part before the part limit, and is null for one past it', async () => {
    const eml = bodiesAround(MAX_MIME_PARTS + 10);
    const before = await partHeaderBlock(stream(eml), '1.2');
    expect(before?.bytes.toString()).toContain('filename="f0.bin"');
    expect(await partHeaderBlock(stream(eml), `1.${MAX_MIME_PARTS + 5}`)).toBeNull();
  });

  it('is null for a path the message has not', async () => {
    expect(await partHeaderBlock(stream(FOLDED), '1.3')).toBeNull();
    expect(await partHeaderBlock(stream(FOLDED), '1.2.1')).toBeNull();
  });

  it('is cut at 256 KB', async () => {
    const big = crlf([
      'Subject: s',
      'Content-Type: multipart/mixed; boundary="b"',
      '',
      '--b',
      `X-Big: ${'z'.repeat(SOURCE_HEADER_BYTES + 100)}`,
      'Content-Type: text/plain',
      '',
      'x',
      '--b--',
      '',
    ]);
    const block = await partHeaderBlock(stream(big), '1.1');
    expect(block?.truncated).toBe(true);
    expect(block?.bytes.length).toBe(SOURCE_HEADER_BYTES);
  });
});
