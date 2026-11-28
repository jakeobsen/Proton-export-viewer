// SPDX-License-Identifier: AGPL-3.0-or-later
// The reader's attachment list and Details: which parts are listed (the
// index's rule, in message order), what each row says, the decoded size as
// the part's transfer decoder gives it, and Details' values cleaned for
// display.

import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { MAX_ATTACHMENTS, NAME_UNITS, extractBody } from '../../src/core/index/body';
import { MAX_MIME_PARTS } from '../../src/core/mime-limits';
import { READER_TIMEOUT_MS } from '../../src/core/reader/lane';
import { renderMessage } from '../../src/core/reader/render';
import { cleanFilename } from '../../src/shared/filename';
import { MAX_REFERENCES } from '../../src/shared/reader-protocol';
import { samplePng } from '../../src/core/png';
import { hostileMessages } from '../../tools/gen-export/hostile.mjs';

const BASE = 'mail-asset://v/0123456789abcdef0123456789abcdef';

const crlf = (lines: string[]) => Buffer.from(lines.join('\r\n'));

function render(bytes: Buffer, mode: 'html' | 'plain' = 'plain') {
  return renderMessage(Readable.from([bytes]), {
    mode,
    assetBase: BASE,
    reread: { open: () => Promise.resolve(Readable.from([bytes])) },
  });
}

const PNG = Buffer.from(samplePng()).toString('base64');

/** A message: an HTML body that shows one cid image, and five attachments of each kind. */
const MIXED = crlf([
  'Subject: Mixed',
  'Message-ID: <id-1@example.org>',
  'Content-Type: multipart/mixed; boundary="m"',
  '',
  '--m',
  'Content-Type: multipart/related; boundary="r"',
  '',
  '--r',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>Hi</p><img src="cid:logo@x">',
  '--r',
  'Content-Type: image/png',
  'Content-ID: <logo@x>',
  'Content-Disposition: inline; filename="logo.png"',
  'Content-Transfer-Encoding: base64',
  '',
  PNG,
  '--r--',
  '--m',
  'Content-Type: application/pdf; name="report.pdf"',
  'Content-Disposition: attachment; filename="report.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  // Stray characters the decoder skips: "hello world!!!!", 15 decoded bytes.
  'aGVsbG8g*d29y!bGQh\r\nISEh',
  '--m',
  'Content-Type: text/plain; name="notes.txt"',
  'Content-Disposition: inline; filename="notes.txt"',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'caf=C3=A9 =',
  'au lait',
  '--m',
  'Content-Type: application/octet-stream',
  'Content-Disposition: attachment',
  '',
  'raw',
  '--m',
  'Content-Type: application/x-msdownload; name="setup.exe"',
  'Content-Disposition: attachment; filename="setup.exe"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('MZ program').toString('base64'),
  '--m--',
  '',
]);

describe('the attachment list', () => {
  it('lists the parts the index lists, in message order, with what each row says', async () => {
    const plain = await render(MIXED, 'plain');
    expect(plain.attachments).toEqual([
      {
        path: '1.1.2',
        name: 'logo.png',
        contentType: 'image/png',
        label: 'PNG image',
        size: samplePng().length,
        risky: false,
        imageFormat: 'png',
        preview: { format: 'png', width: 16, height: 16 },
      },
      {
        path: '1.2',
        name: 'report.pdf',
        contentType: 'application/pdf',
        label: 'PDF document',
        size: 15,
        risky: false,
        imageFormat: null,
        preview: null,
      },
      {
        path: '1.3',
        name: 'notes.txt',
        contentType: 'text/plain',
        label: 'Text',
        size: Buffer.byteLength('café au lait'),
        risky: false,
        imageFormat: null,
        preview: null,
      },
      {
        path: '1.4',
        name: 'attachment',
        contentType: 'application/octet-stream',
        label: 'File',
        size: 3,
        risky: false,
        imageFormat: null,
        preview: null,
      },
      {
        path: '1.5',
        name: 'setup.exe',
        contentType: 'application/x-msdownload',
        label: 'Windows program',
        size: Buffer.byteLength('MZ program'),
        risky: true,
        imageFormat: null,
        preview: null,
      },
    ]);
  });

  it('leaves out an image the HTML body shows by cid, and lists it in plain text', async () => {
    const html = await render(MIXED, 'html');
    expect(html.format).toBe('html');
    expect(html.attachments.map((a) => a.name)).toEqual([
      'report.pdf',
      'notes.txt',
      'attachment',
      'setup.exe',
    ]);
    const plain = await render(MIXED, 'plain');
    expect(plain.attachments.map((a) => a.name)[0]).toBe('logo.png');
  });

  it('counts the decoded size as the transfer decoder gives it, whatever the encoded length', async () => {
    const plain = await render(MIXED, 'plain');
    // base64 with stray characters: the 15 bytes of "hello world!!!!", not 3/4 of the 26
    // encoded characters.
    expect(plain.attachments[1]!.size).toBe(Buffer.byteLength('hello world!!!!'));
    // quoted-printable with an escape and a soft line break.
    expect(plain.attachments[2]!.size).toBe(13);
  });

  it('lists the same parts as the index, in the same order, for every hostile message', async () => {
    const plans = hostileMessages({
      seed: 1,
      nonce: 'parity1',
      labelInfo: { file: { Payload: [] } },
      owner: { Name: 'Owner', Address: 'owner@example.com' },
    }).plans.filter((p) => !p.skipEml);
    let compared = 0;
    for (const plan of plans) {
      const index = await extractBody(Readable.from([plan.emlData])).catch(() => null);
      const reader = await render(plan.emlData, 'plain').catch(() => null);
      if (!index || !reader) continue;
      // A capped index keeps its first rows; the reader's list starts with them.
      if (index.attachmentsCapped) {
        expect(reader.attachments.length, plan.key).toBeGreaterThanOrEqual(
          index.attachments.length,
        );
      } else {
        expect(reader.attachments.length, plan.key).toBe(index.attachments.length);
      }
      for (const [i, row] of index.attachments.entries()) {
        // The index keeps NAME_UNITS of a name; compare the names it kept whole.
        if (row.name.length < NAME_UNITS) {
          expect(reader.attachments[i]!.name, plan.key).toBe(cleanFilename(row.name));
        }
      }
      compared += 1;
    }
    expect(compared).toBeGreaterThan(80);
  });
});

describe('a message with more parts than the limit', () => {
  // Real base64 bodies, so every listed part costs a decode on the first read.
  const SIZE = 600;
  const parts = MAX_MIME_PARTS + 10;
  const eml = crlf([
    'From: <sender@example.com>',
    'To: <owner@example.com>',
    'Subject: Many attachments',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="m"',
    '',
    '--m',
    'Content-Type: text/plain',
    '',
    'Before the attachments.',
    ...Array.from({ length: parts }, (_, i) => [
      '--m',
      'Content-Type: application/octet-stream',
      `Content-Disposition: attachment; filename="f${i}.bin"`,
      'Content-Transfer-Encoding: base64',
      '',
      ...(Buffer.alloc(SIZE, i % 251)
        .toString('base64')
        .match(/.{1,76}/g) ?? []),
    ]).flat(),
    '--m--',
    '',
  ]);

  it('lists every attachment read up to the limit, with decoded sizes, inside the reader time limit', async () => {
    for (const mode of ['plain', 'html'] as const) {
      const started = performance.now();
      const view = await render(eml, mode);
      const took = performance.now() - started;
      expect(view.cut, mode).toBe('parts');
      const n = view.attachments.length;
      expect(n, mode).toBeGreaterThan(MAX_MIME_PARTS - 10);
      expect(n, mode).toBeLessThan(MAX_MIME_PARTS);
      expect(view.attachments.map((a) => a.name)).toEqual(
        Array.from({ length: n }, (_, i) => `f${i}.bin`),
      );
      expect(view.attachments.every((a) => a.size === SIZE)).toBe(true);
      expect(took, mode).toBeLessThan(READER_TIMEOUT_MS);
    }
  });

  it('agrees with the index on the rows the index keeps', async () => {
    const index = await extractBody(Readable.from([eml]));
    expect(index.attachmentsCapped).toBe(true);
    expect(index.attachments).toHaveLength(MAX_ATTACHMENTS);
    const view = await render(eml, 'plain');
    expect(view.attachments.slice(0, MAX_ATTACHMENTS).map((a) => a.name)).toEqual(
      index.attachments.map((row) => cleanFilename(row.name)),
    );
  });
});

describe('Details', () => {
  it('cleans the Message-ID and References for display, and caps References', async () => {
    const refs = Array.from({ length: MAX_REFERENCES + 3 }, (_, i) => `<r${i}@example.org>`);
    const message = await render(
      crlf([
        'Subject: Details',
        'Message-ID: <a\u202emoc.elpmaxe@1>',
        `References: ${refs.join(' ')}`,
        'Content-Type: text/plain',
        '',
        'Hi',
        '',
      ]),
    );
    expect(message.details.messageId).toBe('<amoc.elpmaxe@1>');
    expect(message.details.references).toEqual(refs.slice(0, MAX_REFERENCES));
    expect(message.details.moreReferences).toBe(3);
    expect(message.details.format).toBe('text/plain · Plain text');
  });

  it('describes the structure in one line', async () => {
    const plain = await render(MIXED, 'plain');
    expect(plain.details.format).toBe('multipart/mixed · HTML and plain text · 5 attachments');
    expect(plain.details.messageId).toBe('<id-1@example.org>');
    const html = await render(MIXED, 'html');
    expect(html.details.format).toBe('multipart/mixed · HTML and plain text · 4 attachments');
  });
});
