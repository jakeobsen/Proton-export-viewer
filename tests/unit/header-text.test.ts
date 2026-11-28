// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { MAX_HEADER_VALUE, headerText } from '../../src/shared/header-text';

describe('headerText', () => {
  it('drops bidi and invisible characters, so a value reads as it is stored', () => {
    expect(headerText('<a‮moc.elpmaxe@1>')).toBe('<amoc.elpmaxe@1>');
    expect(headerText('<⁦x⁩@​example.org﻿>')).toBe('<x@example.org>');
  });

  it('shows control characters as symbols', () => {
    expect(headerText('<id@x>\r\nBcc: evil@example.org')).toBe('<id@x>␍␊Bcc: evil@example.org');
    expect(headerText('a\u0000b\u007fc\u0085d')).toBe('a␀b␡c�d');
  });

  it('trims the value and caps it at one header line', () => {
    expect(headerText('  <id@example.org>  ')).toBe('<id@example.org>');
    const long = headerText(`<${'\u{1F600}'.repeat(2000)}>`);
    expect([...long]).toHaveLength(MAX_HEADER_VALUE);
    expect(long.endsWith('…')).toBe(true);
    expect(long).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });
});
