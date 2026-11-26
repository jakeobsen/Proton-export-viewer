// SPDX-License-Identifier: AGPL-3.0-or-later
// Rendering a message for the reader: plain text escaped and linkified with
// opaque link ids, header fields as plain strings, and a body or a failure
// (the reader's fallback) for every malformed-MIME and odd-charset message.

import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { MAX_LINKS, linkUrl, plainBody, trimUrl } from '../../src/core/reader/plain';
import {
  FIRST_TEXT_BYTES,
  HTML_ANYWAY_BYTES,
  HTML_VIEW_BYTES,
  MAX_SUBJECT,
  firstBytes,
  renderMessage,
} from '../../src/core/reader/render';
import { htmlToText } from '../../src/core/text/html-to-text';
import { hostileMessages } from '../../tools/gen-export/hostile.mjs';

const BASE = 'mail-asset://v/0123456789abcdef0123456789abcdef';
const HREF_RE = /href="([^"]*)"/g;

function hrefs(html: string): string[] {
  return [...html.matchAll(HREF_RE)].map((m) => m[1] ?? '');
}

function render(eml: string | Buffer, mode: 'html' | 'plain' | 'html-anyway' = 'plain') {
  const bytes = typeof eml === 'string' ? Buffer.from(eml.replace(/\n/g, '\r\n')) : eml;
  return renderMessage(Readable.from([bytes]), { mode, assetBase: BASE });
}

/** The text inside the body's <pre>, unescaped. */
function bodyText(html: string): string {
  const inner = /<pre>([\s\S]*)<\/pre>/.exec(html)?.[1] ?? '';
  return htmlToText(inner);
}

describe('plain text bodies', () => {
  it('escapes markup', () => {
    const { html, links } = plainBody('<script>alert(1)</script> & "q" \'s\' <b>', BASE);
    expect(html).toContain(
      '&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot; &#39;s&#39; &lt;b&gt;',
    );
    expect(html).not.toContain('<script');
    expect(links).toEqual([]);
  });

  it('turns absolute http, https and mailto URLs into opaque link ids', () => {
    const text = [
      'see https://leak-abc123.test/path?a=1&b=2.',
      'or (http://leak-abc123.test/x_(y)) and mailto:someone@leak-abc123.test,',
      'not javascript:alert(1), data:text/html,hi, ftp://leak-abc123.test/f, www.leak-abc123.test,',
      'someone@leak-abc123.test, xhttps://leak-abc123.test/no or http:// alone.',
      'IP: http://0300.0000.0002.0012/link',
    ].join('\n');
    const { html, links } = plainBody(text, BASE);
    expect(links).toEqual([
      {
        id: 'l1',
        url: 'https://leak-abc123.test/path?a=1&b=2',
        text: 'https://leak-abc123.test/path?a=1&b=2',
      },
      { id: 'l2', url: 'http://leak-abc123.test/x_(y)', text: 'http://leak-abc123.test/x_(y)' },
      { id: 'l3', url: 'mailto:someone@leak-abc123.test', text: 'mailto:someone@leak-abc123.test' },
      { id: 'l4', url: 'http://192.0.2.10/link', text: 'http://0300.0000.0002.0012/link' },
    ]);
    expect(hrefs(html)).toEqual([`${BASE}/l1`, `${BASE}/l2`, `${BASE}/l3`, `${BASE}/l4`]);
    // No URL or host is an attribute value anywhere in the body.
    expect(html).not.toMatch(/(?:href|src)="(?!mail-asset:\/\/v\/[0-9a-f]{32}\/l\d+")/);
    expect(html.match(/<a /g)).toHaveLength(4);
    // The link text is escaped like the rest of the text.
    expect(html).toContain('>https://leak-abc123.test/path?a=1&amp;b=2</a>');
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(bodyText(html)).toBe(text);
  });

  it('trims sentence punctuation and unbalanced brackets, and checks the URL', () => {
    expect(trimUrl('https://a.test/x).')).toBe('https://a.test/x');
    expect(trimUrl('https://a.test/(x)')).toBe('https://a.test/(x)');
    expect(trimUrl('https://a.test/x"!?')).toBe('https://a.test/x');
    expect(linkUrl('https://')).toBeNull();
    expect(linkUrl('mailto:')).toBeNull();
    expect(linkUrl(`https://a.test/${'x'.repeat(9000)}`)).toBeNull();
  });

  it(`makes at most ${MAX_LINKS} links`, () => {
    const text = Array.from({ length: MAX_LINKS + 5 }, (_, i) => `https://a.test/${i}`).join(' ');
    const { links, html } = plainBody(text, BASE);
    expect(links).toHaveLength(MAX_LINKS);
    expect(html.match(/<a /g)).toHaveLength(MAX_LINKS);
    expect(bodyText(html)).toBe(text);
  });
});

describe('rendering a message', () => {
  it('uses the text part of multipart/alternative and passes the headers as plain strings', async () => {
    const message = await render(
      [
        'Subject: =?utf-8?q?<b>h=C3=A9llo</b>?=',
        'From: "A <x>, B" <a@example.org>',
        'To: x@example.org, "Y" <y@example.org>',
        'Cc: c@example.org',
        'Date: Mon, 1 Jan 2024 10:00:00 +0100',
        'Content-Type: multipart/alternative; boundary="b"',
        '',
        '--b',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'plain <i>part</i> https://leak-abc123.test/p',
        '--b',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<p>html part</p>',
        '--b--',
        '',
      ].join('\n'),
    );
    expect(message.headers).toEqual({
      subject: '<b>héllo</b>',
      from: '"A <x>, B" <a@example.org>',
      to: 'x@example.org, "Y" <y@example.org>',
      cc: 'c@example.org',
      date: '2024-01-01T09:00:00.000Z',
    });
    expect(message.format).toBe('plain');
    expect(message.hasHtml).toBe(true);
    expect(bodyText(message.html)).toBe('plain <i>part</i> https://leak-abc123.test/p');
    expect(message.links).toEqual([
      { id: 'l1', url: 'https://leak-abc123.test/p', text: 'https://leak-abc123.test/p' },
    ]);
  });

  const HTML_ONLY = [
    'Subject: h',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<html><head><title>t</title><style>p{}</style></head><body><p>one</p>',
    '<script>bad()</script><div>two &amp; <b>three</b></div><a href="https://leak-abc123.test/">link</a>',
    '<img src="https://leak-abc123.test/i.png"></body></html>',
    '',
  ].join('\n');

  it('shows the text of an HTML-only message as plain text, without scripts or styles', async () => {
    const message = await render(HTML_ONLY, 'plain');
    expect(message.format).toBe('plain');
    expect(message.hasHtml).toBe(true);
    expect(message.remote).toBe(0);
    expect(bodyText(message.html)).toBe('one\n\ntwo & three\nlink');
    expect(message.links).toEqual([]);
    expect(message.html).not.toContain('leak-abc123');
  });

  it('shows an HTML message as sanitized HTML when HTML is asked for', async () => {
    const message = await render(HTML_ONLY, 'html');
    expect(message.format).toBe('html');
    expect(message.hasHtml).toBe(true);
    expect(message.remote).toBe(1);
    expect(message.links).toEqual([{ id: 'l1', url: 'https://leak-abc123.test/', text: 'link' }]);
    expect(message.html).not.toContain('leak-abc123');
    expect(message.html).not.toMatch(/<script|<style|<title/);
    expect(message.html).toContain(`<img src="${BASE}/r1">`);
    expect(message.html).toContain(
      `<a href="${BASE}/l1" target="_blank" rel="noopener noreferrer">link</a>`,
    );
  });

  it('shows a message without HTML as plain text when HTML is asked for', async () => {
    const message = await render(['Subject: p', '', 'just text', ''].join('\n'), 'html');
    expect(message.format).toBe('plain');
    expect(message.hasHtml).toBe(false);
    expect(bodyText(message.html).trim()).toBe('just text');
  });

  it('caps a long subject and gives no date for an invalid one', async () => {
    const message = await render(
      ['Subject: ' + 'x'.repeat(5000), 'Date: not a date', '', 'body', ''].join('\n'),
    );
    expect(message.headers.subject).toHaveLength(MAX_SUBJECT);
    expect(message.headers.subject.endsWith('…')).toBe(true);
    expect(message.headers.date).toBeNull();
    expect(message.headers.from).toBe('');
  });

  it('drains attachments', async () => {
    const message = await render(
      [
        'Content-Type: multipart/mixed; boundary="m"',
        '',
        '--m',
        'Content-Type: text/plain',
        '',
        'see attached',
        '--m',
        'Content-Type: application/octet-stream',
        'Content-Disposition: attachment; filename="a.bin"',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.alloc(300_000, 7).toString('base64'),
        '--m--',
        '',
      ].join('\n'),
    );
    expect(bodyText(message.html)).toBe('see attached');
  });
});

/** A single-part message whose body has exactly `bytes` bytes. */
function sized(type: 'text/html' | 'text/plain', bytes: number, fill = 'x'): Buffer {
  const head = `Subject: Sized\r\nContent-Type: ${type}; charset=utf-8\r\n\r\n`;
  const body =
    type === 'text/html'
      ? `<p>${fill.repeat(bytes - 7)}</p>`
      : fill.repeat(bytes / Buffer.byteLength(fill));
  expect(Buffer.byteLength(body)).toBe(bytes);
  return Buffer.from(head + body);
}

describe('the reader ceilings', () => {
  it('shows HTML up to its size limit, and plain text above it, saying the HTML can be shown anyway', async () => {
    const within = await render(sized('text/html', HTML_VIEW_BYTES), 'html');
    expect(within).toMatchObject({ format: 'html', htmlTooLarge: false, truncated: false });

    const over = sized('text/html', HTML_VIEW_BYTES + 1);
    const asked = await render(over, 'html');
    expect(asked).toMatchObject({ format: 'plain', hasHtml: true, htmlTooLarge: true });
    expect(asked.truncated).toBe(false);
    expect(bodyText(asked.html).trim()).toHaveLength(HTML_VIEW_BYTES + 1 - 7);

    const anyway = await render(over, 'html-anyway');
    expect(anyway).toMatchObject({ format: 'html', htmlTooLarge: false, truncated: false });

    // Plain text was asked for: nothing to offer.
    const plain = await render(over, 'plain');
    expect(plain).toMatchObject({ format: 'plain', htmlTooLarge: false, truncated: false });
  });

  it('shows HTML anyway up to the hard limit, and above it only the first part of its text', async () => {
    const atLimit = await render(sized('text/html', HTML_ANYWAY_BYTES), 'html-anyway');
    expect(atLimit).toMatchObject({ format: 'html', truncated: false });

    const over = sized('text/html', HTML_ANYWAY_BYTES + 1);
    for (const mode of ['html', 'html-anyway', 'plain'] as const) {
      const message = await render(over, mode);
      expect(message).toMatchObject({ format: 'plain', htmlTooLarge: false, truncated: true });
      expect(bodyText(message.html)).toBe('x'.repeat(FIRST_TEXT_BYTES));
    }
  });

  it('shows a text body up to the hard limit whole, and above it only its first part', async () => {
    const whole = await render(sized('text/plain', HTML_ANYWAY_BYTES));
    expect(whole.truncated).toBe(false);
    expect(bodyText(whole.html)).toHaveLength(HTML_ANYWAY_BYTES);

    // Two-byte characters: the cut falls on a character boundary.
    const over = await render(sized('text/plain', HTML_ANYWAY_BYTES + 2, 'é'));
    expect(over).toMatchObject({ format: 'plain', truncated: true, hasHtml: false });
    expect(bodyText(over.html)).toBe('é'.repeat(FIRST_TEXT_BYTES / 2));
  });

  it('cuts text on a character boundary', () => {
    expect(firstBytes('aé', 2)).toBe('a');
    expect(firstBytes('aé', 3)).toBe('aé');
    expect(firstBytes('😀😀', 5)).toBe('😀');
  });
});

describe('the hostile malformed-MIME and charset messages', () => {
  const nonce = randomBytes(6).toString('hex');
  const { plans } = hostileMessages({
    seed: 1,
    nonce,
    labelInfo: { file: { Payload: [] } },
    owner: { Name: 'Owner', Address: 'owner@example.com' },
  });
  const category = (key: string) => key.split('/')[3];
  const name = (key: string) => key.split('/')[4] ?? '';
  const chosen = plans.filter((p) =>
    ['malformed_mime', 'odd_charsets'].includes(category(p.key) ?? ''),
  );

  it('includes both categories', () => {
    expect(chosen.filter((p) => category(p.key) === 'malformed_mime').length).toBeGreaterThan(5);
    expect(chosen.filter((p) => category(p.key) === 'odd_charsets').length).toBeGreaterThan(5);
  });

  const expectedText: Record<string, string> = {
    'iso-8859-1': 'café naïve',
    'windows-1252': '“quoted” €',
    'iso-2022-jp': 'こん',
    shift_jis: 'こんにちは',
    'koi8-r': 'Привет',
    'utf-16': 'hi',
    'lf-only': 'line one\nline two\nline three',
    'unclosed-multipart': 'first part, never closed',
    'deep-multipart': 'deepest',
  };

  for (const plan of chosen) {
    it(`${category(plan.key)}/${name(plan.key)} gives a body or a failure`, async () => {
      const outcome = await Promise.race([
        render(plan.emlData).then(
          (message) => ({ body: message }),
          () => ({ failed: true as const }),
        ),
        new Promise<{ hung: true }>((resolve) => setTimeout(() => resolve({ hung: true }), 3000)),
      ]);
      expect(outcome).not.toHaveProperty('hung');
      if (!('body' in outcome)) return;
      const html = outcome.body.html;
      expect(html.startsWith('<!doctype html>')).toBe(true);
      expect(html).not.toMatch(/<(?!\/?(?:html|head|style|body|pre|a)\b|!doctype)/i);
      const want = expectedText[name(plan.key)];
      if (want !== undefined) expect(bodyText(html).trim()).toBe(want);
    });
  }
});
