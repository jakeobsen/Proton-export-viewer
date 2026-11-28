// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 2's extractor: the body text and attachment names of one message
// file, read as a stream within the text and attachment limits.

import { appendFileSync, closeSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import iconv from 'iconv-lite';
import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_BYTES,
  LIMITS,
  MAX_ATTACHMENTS,
  NAME_UNITS,
  QuotedPrintableDecoder,
  STORED_TEXT_BYTES,
  cutUnits,
  extractBody,
  type BodyText,
} from '../../src/core/index/body';
import { openContained, scanRun, type FileRef } from '../../src/core/containment';
import { BODY_CHANGED, bodyJob, type BodyJobItem } from '../../src/core/index/ops';
import { MAX_MIME_PARTS } from '../../src/core/mime-limits';
import { largeMessage } from '../../tools/gen-export/stream.mjs';
import { testDir } from '../paths';

/** The message as a stream of chunks of `size` bytes, to cross every boundary. */
function chunked(message: string | Buffer, size: number): Readable {
  const buf = typeof message === 'string' ? Buffer.from(message) : message;
  const parts: Buffer[] = [];
  for (let i = 0; i < buf.length; i += size) parts.push(buf.subarray(i, i + size));
  return Readable.from(parts, { objectMode: false });
}

const crlf = (lines: Array<string | Buffer>): Buffer =>
  Buffer.concat(
    lines.flatMap((l, i) => [i ? Buffer.from('\r\n') : Buffer.alloc(0), Buffer.from(l)]),
  );

const wrap = (base64: string) => base64.replace(/(.{76})/g, '$1\r\n');

/** The same result at every chunk size. */
async function atEverySize(message: Buffer, sizes = [1, 2, 3, 7, 64, 4096]): Promise<BodyText> {
  const results = await Promise.all(sizes.map((size) => extractBody(chunked(message, size))));
  for (const r of results.slice(1)) expect(r).toEqual(results[0]);
  return results[0]!;
}

const MARKS = '';

/** A multipart/mixed message: a short body, then these parts. */
function mixed(parts: string[][]): Buffer {
  return crlf([
    'Subject: parts',
    'Content-Type: multipart/mixed; boundary="m"',
    '',
    '--m',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'see attached',
    ...parts.flatMap((p) => ['--m', ...p]),
    '--m--',
    '',
  ]);
}

const named = (name: string, body = 'x') => [
  `Content-Type: application/octet-stream; name="${name}"`,
  'Content-Disposition: attachment',
  '',
  body,
];

describe('the body text', () => {
  it('decodes base64 and quoted-printable split anywhere', async () => {
    const text = 'Grüße aus Köln, und noch einmal. '.repeat(12);
    const base64 = crlf([
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrap(Buffer.from(text).toString('base64')),
      '',
    ]);
    expect((await atEverySize(base64)).body).toBe(`${text}\n`);
    const qp = crlf([
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Gr=C3=BC=C3=9Fe aus K=C3=B6ln, a soft=',
      ' break and =3D sign=',
      '',
      '',
    ]);
    const r = await atEverySize(qp);
    expect(r.body).toBe('Grüße aus Köln, a soft break and = sign\n');
    expect(r).toMatchObject({ truncated: false, attachments: [], attachmentsCapped: false });
  });

  it('carries an escape, or a soft line break with its padding, from one chunk to the next', () => {
    const encoded = Buffer.from('Hello =\r\nworld, padding=  \t\r\nends =3D here', 'latin1');
    const decoded = (chunks: Buffer[]) => {
      const d = new QuotedPrintableDecoder();
      return Buffer.concat([...chunks.map((c) => d.write(c)), d.end()]).toString('latin1');
    };
    for (let i = 1; i < encoded.length; i += 1) {
      for (let j = i; j < encoded.length; j += 1) {
        const parts = [encoded.subarray(0, i), encoded.subarray(i, j), encoded.subarray(j)];
        expect(decoded(parts), `split at ${i}, ${j}`).toBe('Hello world, paddingends = here');
      }
    }
  });

  it('keeps the spaces before a quoted-printable soft break and drops the padding after it, split anywhere', async () => {
    const qp = crlf([
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Hello =',
      'world, two spaces  =',
      'here; padding=  \t',
      'gone=',
      '',
      '',
    ]);
    const r = await atEverySize(qp, [1, 2, 3, 4, 5, 7, 64, 4096]);
    expect(r.body).toBe('Hello world, two spaces  here; paddinggone\n');
  });

  it('decodes odd charsets, and reads an unknown one as UTF-8', async () => {
    const cases: Array<[string, string]> = [
      ['iso-8859-1', 'Café crème'],
      ['windows-1252', 'Price: 5 € – “quoted”'],
      ['KOI8-R', 'Привет, мир'],
      ['shift_jis', 'こんにちは世界'],
      ['EUC-KR', '안녕하세요'],
      ['big5', '中文郵件'],
      ['utf-16le', 'Wide ünïcode'],
    ];
    for (const [charset, text] of cases) {
      const message = crlf([
        `Content-Type: text/plain; charset="${charset}"`,
        'Content-Transfer-Encoding: base64',
        '',
        wrap(iconv.encode(text, charset).toString('base64')),
        '',
      ]);
      expect((await atEverySize(message)).body, charset).toBe(`${text}\n`);
    }
    const unknown = crlf(['Content-Type: text/plain; charset=x-no-such-set', '', 'Grüße', '']);
    expect((await atEverySize(unknown)).body).toBe('Grüße\n');
  });

  it('turns HTML into text without scripts, styles, tags or entities', async () => {
    const html =
      '<html><head><title>Title</title><style>p{color:red}</style></head><body>' +
      '<p>Fish &amp; chips</p><script>steal()</script><div>tail &eacute;</div></body></html>';
    const message = crlf([
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrap(Buffer.from(html).toString('base64')),
      '',
    ]);
    const { body } = await atEverySize(message);
    expect(body).toContain('Fish & chips');
    expect(body).toContain('tail é');
    expect(body).not.toMatch(/steal|color|<|Title/);
  });

  it('reads only the first text part of an alternative', async () => {
    const plainFirst = crlf([
      'Content-Type: multipart/mixed; boundary="m"',
      '',
      '--m',
      'Content-Type: multipart/alternative; boundary="a"',
      '',
      '--a',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'plain version',
      '--a',
      'Content-Type: multipart/related; boundary="r"',
      '',
      '--r',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>html version</p>',
      '--r',
      'Content-Type: image/png',
      'Content-ID: <logo@example.com>',
      'Content-Transfer-Encoding: base64',
      '',
      'iVBORw0KGgo=',
      '--r--',
      '--a--',
      '--m',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'a second body part',
      '--m--',
      '',
    ]);
    const r = await atEverySize(plainFirst);
    expect(r.body).toContain('plain version');
    expect(r.body).not.toContain('html version');
    // A text part after the alternative is read as usual.
    expect(r.body).toContain('a second body part');
    // The image has neither a filename nor an attachment disposition: no row.
    expect(r.attachments).toEqual([]);

    const htmlFirst = crlf([
      'Content-Type: multipart/alternative; boundary="a"',
      '',
      '--a',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>html first</p>',
      '--a',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'plain second',
      '--a--',
      '',
    ]);
    const h = await atEverySize(htmlFirst);
    expect(h.body).toContain('html first');
    expect(h.body).not.toContain('plain second');
  });

  it('removes the characters search marks matches with', async () => {
    const message = crlf([
      'Content-Type: multipart/mixed; boundary="m"',
      '',
      '--m',
      'Content-Type: text/plain; charset=utf-8',
      '',
      `plain ${MARKS}text`,
      '--m',
      'Content-Type: text/html; charset=utf-8',
      'Content-Disposition: inline',
      '',
      '<p>html &#xE000;entity&#xE001; and raw</p>',
      '--m',
      `Content-Type: application/pdf; name="re${MARKS}port.pdf"`,
      'Content-Disposition: attachment',
      `Content-ID: <cid${MARKS}@example.com>`,
      '',
      'x',
      '--m--',
      '',
    ]);
    const r = await atEverySize(message);
    expect(r.body).toContain('plain text');
    expect(r.body).toContain('html entity and raw');
    expect(r.body).not.toMatch(/[]/);
    expect(r.attachments).toEqual([
      { name: 'report.pdf', mime: 'application/pdf', contentId: 'cid@example.com', size: 1 },
    ]);
    expect(r.attachmentText).toBe('report.pdf');
  });

  it('keeps at most 1 MB of UTF-8 text, cut on a character boundary', async () => {
    const line = 'ünï€😀 '.repeat(1000);
    const body = Array.from(
      { length: Math.ceil(STORED_TEXT_BYTES / Buffer.byteLength(line)) + 1 },
      () => line,
    ).join('\r\n');
    const message = crlf(['Content-Type: text/plain; charset=utf-8', '', body, '']);
    const r = await extractBody(chunked(message, 65536));
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.body)).toBeLessThanOrEqual(STORED_TEXT_BYTES);
    expect(Buffer.byteLength(r.body)).toBeGreaterThan(STORED_TEXT_BYTES - 1000);
    expect(r.body).not.toContain('�');
    expect(r.body).not.toContain('\r');
    expect(body.replace(/\r\n/g, '\n').startsWith(r.body)).toBe(true);
    // Exactly at the limit is not cut.
    const exact = 'a'.repeat(STORED_TEXT_BYTES - 1);
    const fits = await extractBody(
      chunked(crlf(['Content-Type: text/plain', '', exact, '']), 65536),
    );
    expect(fits).toMatchObject({ truncated: false });
    expect(fits.body).toBe(`${exact}\n`);
  });

  it('reads at most the raw text limit', async () => {
    const message = largeMessage({ kind: 'text', bytes: 256 * 1024, seed: 3 });
    const r = await extractBody(message, { ...LIMITS, rawText: 64 * 1024 });
    expect(r.rawTextBytes).toBe(64 * 1024);
    expect(r.truncated).toBe(true);
    expect(r.inputBytes).toBeGreaterThan(256 * 1024);
  });

  it('never keeps a 200 MB text or HTML part: memory stays flat and the body is cut', async () => {
    for (const kind of ['text', 'html'] as const) {
      const before = process.memoryUsage.rss();
      let peak = before;
      const sample = setInterval(() => {
        peak = Math.max(peak, process.memoryUsage.rss());
      }, 10);
      let r: BodyText;
      try {
        r = await extractBody(largeMessage({ kind, bytes: 200_000_000, seed: 5 }));
      } finally {
        clearInterval(sample);
      }
      peak = Math.max(peak, process.memoryUsage.rss());
      expect(peak - before, kind).toBeLessThan(64 * 1024 * 1024);
      expect(r.truncated, kind).toBe(true);
      expect(Buffer.byteLength(r.body), kind).toBeLessThanOrEqual(STORED_TEXT_BYTES);
      expect(r.inputBytes, kind).toBeGreaterThan(200_000_000);
    }
  }, 120_000);
});

describe('the attachment list', () => {
  it('lists each attachment with its name, type, content ID and decoded size', async () => {
    const payload = Buffer.from('%PDF-1.4 binary \u0000\u0001 data'.repeat(30));
    const message = mixed([
      [
        'Content-Type: application/pdf',
        "Content-Disposition: attachment; filename*=utf-8''na%C3%AFve%20report.pdf",
        'Content-Transfer-Encoding: base64',
        '',
        wrap(payload.toString('base64')),
      ],
      [
        'Content-Type: text/plain; charset=utf-8; name="notes.txt"',
        'Content-Disposition: attachment',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        'secret attachment words =C3=A9=',
        'nd',
      ],
      [
        'Content-Type: image/png; name="inline.png"',
        'Content-Disposition: inline',
        'Content-ID: <img-1@example.com>',
        'Content-Transfer-Encoding: base64',
        '',
        'iVBORw0KGgo=',
      ],
      [
        'Content-Type: message/rfc822',
        'Content-Disposition: attachment; filename="forwarded.eml"',
        '',
        'Subject: inner',
        'Content-Type: text/plain',
        '',
        'inner body words',
      ],
    ]);
    const r = await atEverySize(message);
    expect(r.body.trim()).toBe('see attached');
    expect(r.attachments).toEqual([
      { name: 'naïve report.pdf', mime: 'application/pdf', contentId: '', size: payload.length },
      {
        name: 'notes.txt',
        mime: 'text/plain',
        contentId: '',
        size: Buffer.byteLength('secret attachment words énd'),
      },
      { name: 'inline.png', mime: 'image/png', contentId: 'img-1@example.com', size: 8 },
      { name: 'forwarded.eml', mime: 'message/rfc822', contentId: '', size: expect.any(Number) },
    ]);
    expect(r.attachmentText).toBe('naïve report.pdf\nnotes.txt\ninline.png\nforwarded.eml');
    expect(r.attachmentsCapped).toBe(false);
  });

  it(`keeps ${MAX_ATTACHMENTS} rows of 1,001 parts, and the first part past the limit ends the list`, async () => {
    const names = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => `f${i}.txt`);
    const r = await extractBody(chunked(mixed(names.map((n) => named(n))), 65536));
    expect(r.attachments).toHaveLength(MAX_ATTACHMENTS);
    expect(r.attachments.map((a) => a.name)).toEqual(names.slice(0, MAX_ATTACHMENTS));
    expect(r.attachmentText).toBe(names.slice(0, MAX_ATTACHMENTS).join('\n'));
    expect(r.attachmentsCapped).toBe(true);
    expect(r.body.trim()).toBe('see attached');
    // Exactly at the limit, nothing is cut.
    const fit = await extractBody(
      chunked(mixed(names.slice(0, MAX_ATTACHMENTS).map((n) => named(n))), 65536),
    );
    expect(fit.attachments).toHaveLength(MAX_ATTACHMENTS);
    expect(fit.attachmentsCapped).toBe(false);
  });

  it('stops at 256 KiB of attachment data with long names of 3-byte characters', async () => {
    const names = Array.from({ length: 400 }, (_, i) => `${i}`.padStart(3, '0') + '日'.repeat(300));
    const r = await extractBody(chunked(mixed(names.map((n) => named(n))), 65536));
    expect(r.attachmentsCapped).toBe(true);
    const kept = r.attachments.map((a) => a.name);
    // Each name is cut to 255 units.
    expect(kept.every((n) => n.length === NAME_UNITS)).toBe(true);
    expect(kept).toEqual(names.slice(0, kept.length).map((n) => n.slice(0, NAME_UNITS)));
    expect(r.attachmentText).toBe(kept.join('\n'));
    const bytes = (rows: typeof r.attachments, text: string) =>
      rows.reduce(
        (n, a) =>
          n +
          Buffer.byteLength(a.name) +
          Buffer.byteLength(a.mime) +
          Buffer.byteLength(a.contentId),
        Buffer.byteLength(text),
      );
    expect(bytes(r.attachments, r.attachmentText)).toBeLessThanOrEqual(ATTACHMENT_BYTES);
    // The next name would have passed the limit.
    const next = {
      name: names[kept.length]!.slice(0, NAME_UNITS),
      mime: 'application/octet-stream',
      contentId: '',
      size: 1,
    };
    expect(bytes([...r.attachments, next], `${r.attachmentText}\n${next.name}`)).toBeGreaterThan(
      ATTACHMENT_BYTES,
    );
  });

  it('reads a message past the parser limits up to there, cut', async () => {
    const parts = Array.from({ length: MAX_MIME_PARTS + 10 }, (_, i) => named(`p${i}`));
    const many = await extractBody(chunked(mixed(parts), 65536));
    expect(many).toMatchObject({ truncated: true, attachmentsCapped: true });
    expect(many.attachments).toHaveLength(MAX_ATTACHMENTS);
    expect(many.body.trim()).toBe('see attached');
    const head = mixed([
      ['Content-Type: text/plain', `X-Long: ${'h'.repeat(3 * 1024 * 1024)}`, '', 'after'],
    ]);
    const long = await extractBody(chunked(head, 65536));
    expect(long).toMatchObject({ truncated: true, attachmentsCapped: true, attachments: [] });
    expect(long.body.trim()).toBe('see attached');
  });

  it('fails on an input error, even one that carries the limit code, as only the splitter ends a read early', async () => {
    const failing = (error: Error) =>
      Readable.from(
        (async function* () {
          yield Buffer.from('Subject: Broken\r\nContent-Type: text/plain\r\n\r\nSome text');
          throw error;
        })(),
      );
    await expect(extractBody(failing(new Error('read failed')))).rejects.toThrow('read failed');
    const limitCode = Object.assign(new Error('input limit'), { code: 'EMAXLEN' });
    await expect(extractBody(failing(limitCode))).rejects.toThrow('input limit');
  });

  it('cuts a long name at 255 units without splitting a character outside the BMP', async () => {
    const long = 'n'.repeat(300);
    const astral = `${'a'.repeat(NAME_UNITS - 1)}😀tail`;
    const r = await atEverySize(mixed([named(long), named(astral)]));
    expect(r.attachments.map((a) => a.name)).toEqual([
      'n'.repeat(NAME_UNITS),
      'a'.repeat(NAME_UNITS - 1),
    ]);
    expect(cutUnits(astral, NAME_UNITS + 1)).toBe(`${'a'.repeat(NAME_UNITS - 1)}😀`);
    expect(cutUnits('short', NAME_UNITS)).toBe('short');
  });
});

describe('the body job', () => {
  /** Runs the job as core does: on a descriptor opened through the containment checks. */
  async function job(dir: string, item: BodyJobItem & { ref: FileRef }) {
    const fd = openContained(dir, item.ref);
    try {
      return await bodyJob(fd, item);
    } finally {
      closeSync(fd);
    }
  }

  const message = (body: string) =>
    ['Subject: s', 'Content-Type: text/plain; charset=utf-8', '', body, ''].join('\r\n');

  function folder(name: string, body: string) {
    const dir = testDir(name);
    writeFileSync(join(dir, 'a.metadata.json'), '{}');
    writeFileSync(join(dir, 'a.eml'), message(body));
    const ref = scanRun(dir).eml.get('a')!;
    return { dir, ref, file: join(dir, 'a.eml') };
  }

  it('reads the file the scan found', async () => {
    const { dir, ref } = folder('body-job-ok', 'plain words');
    const r = await job(dir, { protonId: 'a', rev: 4, ref });
    expect(r).toMatchObject({ protonId: 'a', rev: 4, ok: true, body: 'plain words\n' });
  });

  it('leaves a file that changed before or while it was read', async () => {
    const before = folder('body-job-before', 'first');
    writeFileSync(before.file, message('second, longer'));
    expect(await job(before.dir, { protonId: 'a', rev: 1, ref: before.ref })).toEqual({
      protonId: 'a',
      rev: 1,
      ok: false,
      error: BODY_CHANGED,
    });
    // The same size, written later.
    const same = folder('body-job-same-size', 'first');
    writeFileSync(same.file, message('fixed'));
    utimesSync(same.file, new Date(2030, 0, 1), new Date(2030, 0, 1));
    expect(await job(same.dir, { protonId: 'a', rev: 1, ref: same.ref })).toMatchObject({
      ok: false,
      error: BODY_CHANGED,
    });

    // Large enough to take many reads; it grows after the first.
    const during = folder('body-job-during', 'words '.repeat(2_000_000));
    const reading = job(during.dir, { protonId: 'a', rev: 1, ref: during.ref });
    await new Promise((resolve) => setImmediate(resolve));
    appendFileSync(during.file, 'more\r\n');
    expect(await reading).toMatchObject({ ok: false, error: BODY_CHANGED });
  });

  it('reads a file past the parser limits up to there, truncated and capped, and checks it again', async () => {
    const dir = testDir('body-job-limit');
    writeFileSync(join(dir, 'a.metadata.json'), '{}');
    const parts = Array.from({ length: MAX_MIME_PARTS + 10 }, (_, i) => named(`p${i}`));
    writeFileSync(join(dir, 'a.eml'), mixed(parts));
    const ref = scanRun(dir).eml.get('a')!;
    expect(await job(dir, { protonId: 'a', rev: 1, ref })).toMatchObject({
      protonId: 'a',
      rev: 1,
      ok: true,
      truncated: true,
      attachmentsCapped: true,
    });
  });
});
