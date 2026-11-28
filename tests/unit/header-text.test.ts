// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { MAX_HEADER_VALUE, headerText } from '../../src/shared/header-text';

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
});
