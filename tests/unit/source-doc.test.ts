// SPDX-License-Identifier: AGPL-3.0-or-later
// The source view's header document is inert, escaped text in which nothing
// hides or reorders, and the tree's type and charset are plain tokens only.

import { describe, expect, it } from 'vitest';
import { CUT_NOTE, headerDocument, headerText } from '../../src/main/source-doc';
import {
  displayCharset,
  displayType,
  sourceNodes,
  UNKNOWN_TYPE,
} from '../../src/main/source-parts';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('headerText', () => {
  it('keeps tab and line feed, makes CRLF a line feed, and shows a lone CR', () => {
    expect(headerText(bytes('A: 1\r\n\tfolded\r\nB: 2\rC'))).toBe('A: 1\n\tfolded\nB: 2<U+000D>C');
  });

  it('shows every control, format, separator and default-ignorable character as an escape', () => {
    const hidden = [
      '\u0001',
      '\u001b',
      '\u007f',
      '\u0085',
      '\u00ad', // soft hyphen
      '\u061c',
      '\u180e',
      '\u200b',
      '\u200e',
      '\u202a',
      '\u202e',
      '\u2028',
      '\u2029',
      '\u2066',
      '\u2069',
      '\u206a',
      '\u206f',
      '\ufe0f', // variation selector
      '\ufeff',
      '\ufff9',
      '\ufffb',
    ];
    for (const ch of hidden) {
      const code = ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
      expect(headerText(bytes(`X: a${ch}b`))).toBe(`X: a<U+${code}>b`);
    }
  });

  it('shows a run of tag characters, which can hide a whole word, as escapes', () => {
    const tags = [...'evil'].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('');
    expect(headerText(bytes(`Subject: ok${tags}`))).toBe(
      'Subject: ok<U+E0065><U+E0076><U+E0069><U+E006C>',
    );
  });

  it('gives a replacement character for bytes that are not UTF-8', () => {
    expect(headerText(new Uint8Array([0x58, 0x3a, 0x20, 0xff, 0x41]))).toBe('X: �A');
  });
});

describe('headerDocument', () => {
  it('escapes markup, so a header with a script is text', () => {
    const { html, text } = headerDocument(
      bytes('Subject: <script>alert(1)</script>\r\nX-Q: "a" & \'b\'\r\n'),
      false,
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;a&quot; &amp; &#39;b&#39;');
    expect(text).toBe('Subject: <script>alert(1)</script>\nX-Q: "a" & \'b\'\n');
    expect(html).not.toContain(CUT_NOTE);
  });

  it('marks each escape and each field name, and says when the block was cut', () => {
    const { html } = headerDocument(bytes('Subject: a\u202eb\r\n'), true);
    expect(html).toContain('<span class="hn">Subject:</span>');
    expect(html).toContain('<span class="esc">&lt;U+202E&gt;</span>');
    expect(html).toContain(`<p class="cut">${CUT_NOTE}</p>`);
    // No character of the input reaches the document unescaped.
    expect(html).not.toContain('\u202e');
  });

  it('has nothing that runs or loads', () => {
    const { html, text } = headerDocument(
      bytes(
        'X: <img src=x onerror=alert(1)><a href="//e.example">\r\n' +
          '<script>alert(1)</script><img/src=x/onerror=alert(1)>&amp;: v\r\n',
      ),
      false,
    );
    expect(html).not.toMatch(/<(?!\/?(?:html|head|meta|style|body|pre|span|p)\b|!doctype)/i);
    // The input shows as text: no tag carries an event handler.
    expect(html).not.toMatch(/<[^>]*\son\w+=/i);
    // A field name with markup is escaped like a value.
    expect(html).toContain(
      '<span class="hn">&lt;script&gt;alert(1)&lt;/script&gt;&lt;img/src=x/onerror=alert(1)&gt;&amp;amp;:</span> v',
    );
    expect(text).toContain('<script>alert(1)</script><img/src=x/onerror=alert(1)>&amp;: v');
  });
});

describe('displayType', () => {
  it('passes a plain lower-case type/subtype, and nothing else', () => {
    expect(displayType('application/pdf')).toBe('application/pdf');
    expect(displayType('Text/HTML')).toBe('text/html');
    expect(
      displayType('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    ).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(displayType('text/ht\u202eml')).toBe(UNKNOWN_TYPE);
    expect(displayType(`text/${'x'.repeat(76)}`)).toBe(UNKNOWN_TYPE);
    // Each token within its own bound, the whole over 80 characters.
    expect(displayType(`${'a'.repeat(30)}/${'b'.repeat(55)}`)).toBe(UNKNOWN_TYPE);
    expect(displayType(`${'a'.repeat(30)}/${'b'.repeat(49)}`)).toBe(
      `${'a'.repeat(30)}/${'b'.repeat(49)}`,
    );
    expect(displayType('text')).toBe(UNKNOWN_TYPE);
    expect(displayType('')).toBe(UNKNOWN_TYPE);
    expect(displayType('text/plain; charset=utf-8')).toBe(UNKNOWN_TYPE);
    expect(displayType('a/b/c')).toBe(UNKNOWN_TYPE);
  });
});

describe('displayCharset', () => {
  it('passes a short token, lower case, or none', () => {
    expect(displayCharset('UTF-8')).toBe('utf-8');
    expect(displayCharset('iso-2022-jp')).toBe('iso-2022-jp');
    expect(displayCharset(null)).toBeNull();
    expect(displayCharset('utf\u202e8')).toBeNull();
    expect(displayCharset('x'.repeat(41))).toBeNull();
    expect(displayCharset('"utf-8"')).toBeNull();
    expect(displayCharset('')).toBeNull();
  });
});

describe('sourceNodes', () => {
  it('filters the type and charset and flags a risky name', () => {
    expect(
      sourceNodes([
        {
          path: '1',
          parent: -1,
          contentType: 'multipart/mixed',
          charset: null,
          name: '',
          inline: false,
          size: 10,
          cut: false,
        },
        {
          path: '1.1',
          parent: 0,
          contentType: 'application/x-msdownload\u202e',
          charset: 'Bad Charset',
          name: 'setup.exe',
          inline: false,
          size: 10,
          cut: true,
        },
      ]),
    ).toEqual([
      {
        path: '1',
        parent: -1,
        type: 'multipart/mixed',
        charset: null,
        name: '',
        inline: false,
        size: 10,
        cut: false,
        risky: false,
      },
      {
        path: '1.1',
        parent: 0,
        type: UNKNOWN_TYPE,
        charset: null,
        name: 'setup.exe',
        inline: false,
        size: 10,
        cut: true,
        risky: true,
      },
    ]);
  });
});
