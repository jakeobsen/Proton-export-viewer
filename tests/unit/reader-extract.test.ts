// SPDX-License-Identifier: AGPL-3.0-or-later
// Reading a message for the reader: which parts are bodies, how they are
// decoded, and how much of each body kind is kept.

import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { extractMessage } from '../../src/core/reader/extract';
import { MAX_MIME_PARTS } from '../../src/core/mime-limits';
import { bodiesAfter, bodiesAround } from '../mime-parts';

function read(eml: string, keepBytes?: number) {
  return extractMessage(Readable.from([Buffer.from(eml.replace(/\r?\n/g, '\r\n'))]), keepBytes);
}

const HEAD = ['From: a@example.org', 'To: b@example.com', 'Subject: Parts', 'MIME-Version: 1.0'];

describe('choosing the body parts', () => {
  it('reads inline text and HTML parts and skips attachments, other types and attached messages', async () => {
    const eml = [
      ...HEAD,
      'Content-Type: multipart/mixed; boundary="b1"',
      '',
      '--b1',
      'Content-Type: multipart/alternative; boundary="b2"',
      '',
      '--b2',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'plain one',
      '--b2',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>html one</p>',
      '--b2--',
      '--b1',
      'Content-Type: text/plain',
      'Content-Disposition: attachment; filename="notes.txt"',
      '',
      'attached text',
      '--b1',
      'Content-Type: application/octet-stream',
      '',
      'binary',
      '--b1',
      'Content-Type: message/rfc822',
      '',
      'Subject: inner',
      'Content-Type: text/plain',
      '',
      'inner text',
      '--b1',
      'Content-Type: message/delivery-status',
      '',
      'Status: 5.0.0',
      '--b1',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Disposition: inline',
      '',
      'plain two',
      '--b1--',
      '',
    ].join('\n');
    const message = await read(eml);
    expect(message.text.content).toBe('plain one\nStatus: 5.0.0\nplain two');
    expect(message.html.content).toBe('<p>html one</p>');
    expect(message.headers?.get('subject')).toBe('Parts');
    expect(message.text.cut || message.html.cut).toBe(false);
  });

  it('reads a root part without a content type as text', async () => {
    const message = await read(['Subject: bare', '', 'just text', ''].join('\n'));
    expect(message.text.content).toBe('just text\n');
    expect(message.html.content).toBe('');
  });
});

describe('decoding the body parts', () => {
  it('decodes transfer encodings and charsets, and unfolds format=flowed', async () => {
    const latin1 = Buffer.from('café naïve', 'latin1').toString('base64');
    const eml = [
      ...HEAD,
      'Content-Type: multipart/mixed; boundary="b"',
      '',
      '--b',
      'Content-Type: text/plain; charset=iso-8859-1',
      'Content-Transfer-Encoding: base64',
      '',
      latin1,
      '--b',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'caf=C3=A9 =',
      'au lait',
      '--b',
      'Content-Type: text/plain; charset=utf-8; format=flowed; delsp=yes',
      '',
      'one long ',
      'line',
      '--b--',
      '',
    ].join('\n');
    const message = await read(eml);
    expect(message.text.content).toBe('café naïve\ncafé au lait\none longline');
  });

  it('does not decode UTF-7, which could turn plain characters into markup', async () => {
    const message = await read(
      [
        ...HEAD,
        'Content-Type: text/html; charset=utf-7',
        '',
        '+ADw-script+AD4-alert(1)+ADw-/script+AD4-',
        '',
      ].join('\n'),
    );
    expect(message.html.content).not.toContain('<script');
    expect(message.html.content).toContain('+ADw-script+AD4-');
  });
});

describe('the bytes kept of each body kind', () => {
  it('keeps the first bytes of a kind, counts all of them, and drops the rest', async () => {
    const eml = [
      ...HEAD,
      'Content-Type: multipart/mixed; boundary="b"',
      '',
      '--b',
      'Content-Type: text/plain',
      '',
      'a'.repeat(60),
      '--b',
      'Content-Type: text/plain',
      '',
      'b'.repeat(60),
      '--b',
      'Content-Type: text/html',
      '',
      `<p>${'c'.repeat(40)}</p>`,
      '--b',
      'Content-Type: application/octet-stream',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.alloc(3000).toString('base64'),
      '--b--',
      '',
    ].join('\n');
    const message = await read(eml, 100);
    // 60 + 60 encoded bytes of text: the first 100 are kept.
    expect(message.text.cut).toBe(true);
    expect(message.text.bytes).toBe(120);
    expect(message.text.content).toBe(`${'a'.repeat(60)}\n${'b'.repeat(40)}`);
    // The HTML kind has a limit of its own; attachments count toward neither.
    expect(message.html.cut).toBe(false);
    expect(message.html.bytes).toBe(47);
    expect(message.html.content).toBe(`<p>${'c'.repeat(40)}</p>`);
  });
});

describe('the part limit', () => {
  const stream = (eml: string) => Readable.from([Buffer.from(eml)]);

  it('reads bodies that come after more than 1,000 parts', async () => {
    const message = await extractMessage(stream(bodiesAfter(1001)));
    expect(message.stopped).toBe(false);
    expect(message.text.content).toContain('Text after the parts.');
    expect(message.html.content).toContain('HTML after the parts.');
    expect(message.headers?.get('subject')).toBe('Many parts');
  });

  it('stops at the limit and keeps what came before', async () => {
    const message = await extractMessage(stream(bodiesAround(MAX_MIME_PARTS + 10)));
    expect(message.stopped).toBe(true);
    expect(message.text.content).toContain('Text before the parts.');
    expect(message.text.content).not.toContain('after the parts');
    expect(message.html.content).toContain('HTML before the parts.');
    expect(message.html.content).not.toContain('after the parts');
    expect(message.headers?.get('subject')).toBe('Many parts');
  });

  it('stops at a header block over the limit and keeps what came before', async () => {
    const eml = [
      'Subject: Long header',
      'Content-Type: multipart/mixed; boundary="m"',
      '',
      '--m',
      'Content-Type: text/plain',
      '',
      'Before the long header.',
      '--m',
      'Content-Type: text/plain',
      `X-Long: ${'h'.repeat(3 * 1024 * 1024)}`,
      '',
      'After it.',
      '--m--',
      '',
    ].join('\r\n');
    const message = await extractMessage(stream(eml));
    expect(message.stopped).toBe(true);
    expect(message.text.content).toContain('Before the long header.');
    expect(message.text.content).not.toContain('After it.');
  });

  it('fails on any other read error', async () => {
    async function* broken() {
      yield Buffer.from('Subject: Broken\r\nContent-Type: text/plain\r\n\r\nSome text');
      throw new Error('read failed');
    }
    await expect(extractMessage(Readable.from(broken()))).rejects.toThrow('read failed');
  });

  it('fails on an input error that carries the limit code, as only the splitter ends a read early', async () => {
    async function* broken() {
      yield Buffer.from('Subject: Broken\r\nContent-Type: text/plain\r\n\r\nSome text');
      throw Object.assign(new Error('input limit'), { code: 'EMAXLEN' });
    }
    await expect(extractMessage(Readable.from(broken()))).rejects.toThrow('input limit');
  });
});
