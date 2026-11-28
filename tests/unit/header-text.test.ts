// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { MAX_HEADER_VALUE, displayText, headerText } from '../../src/shared/header-text';

describe('headerText', () => {
  it('drops bidi and invisible characters, so a value reads as it is stored', () => {
    expect(headerText('<a\u202emoc.elpmaxe@1>')).toBe('<amoc.elpmaxe@1>');
    expect(headerText('<\u2066x\u2069@\u200bexample.org\ufeff>')).toBe('<x@example.org>');
  });

  it('shows control characters as symbols', () => {
    expect(headerText('<id@x>\r\nBcc: evil@example.org')).toBe('<id@x>␍␊Bcc: evil@example.org');
    expect(headerText('a\u0000b\u007fc\u0085d')).toBe('a␀b␡c�d');
  });

  it('shows the line and paragraph separators as the replacement character, so a value stays one line', () => {
    expect(headerText('<a\u2028b@x>\u2029Bcc: y')).toBe('<a\ufffdb@x>\ufffdBcc: y');
  });

  it('trims the value and caps it at one header line', () => {
    expect(headerText('  <id@example.org>  ')).toBe('<id@example.org>');
    const long = headerText(`<${'\u{1F600}'.repeat(2000)}>`);
    expect([...long]).toHaveLength(MAX_HEADER_VALUE);
    expect(long.endsWith('…')).toBe(true);
    expect(long).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it('keeps the zero-width joiner and non-joiner, which shape text without moving it', () => {
    const family = '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}';
    const word = 'می\u200cخواهم';
    expect(headerText(`\u202e${family} ${word}\u200b`)).toBe(`${family} ${word}`);
  });

  it('drops the soft hyphen, the Arabic letter mark, the invisible operators and the tag block', () => {
    expect(headerText('a\u00adb\u061cc\u2060d\u2061e\u2064f\ufeffg')).toBe('abcdefg');
    expect(headerText('flag\u{e0067}\u{e0062}\u{e007f} x\u{e0000}y\u{e0041}')).toBe('flag xy');
  });
});

describe('displayText', () => {
  it('shows a subject or a name as one line: white space runs as one space', () => {
    expect(displayText('  Re:\tLunch\r\n\tplans\u2028 \u00a0today  ')).toBe(
      'Re: Lunch plans today',
    );
  });

  it('drops format characters before it joins spaces, so none leaves two spaces', () => {
    expect(displayText('\u202eQuarterly \u200b report')).toBe('Quarterly report');
    expect(displayText('\u2066Ann\u2069 \ufeff Lee')).toBe('Ann Lee');
  });

  it('shows the remaining controls as symbols', () => {
    expect(displayText('Eve\u0007 Mallory\u0000\u007f\u0085')).toBe('Eve␇ Mallory␀␡�');
  });

  it('keeps a right-to-left subject whole, with its joiners', () => {
    const subject = 'سلام، می\u200cخواهم';
    expect(displayText(subject)).toBe(subject);
    expect(displayText('Ava \u{1f468}\u200d\u{1f469}\u200d\u{1f467}')).toBe(
      'Ava \u{1f468}\u200d\u{1f469}\u200d\u{1f467}',
    );
  });

  it('gives nothing for a value of only invisible characters and space', () => {
    expect(displayText('\u202e\u200b \t\u2066\u2069')).toBe('');
  });
});
