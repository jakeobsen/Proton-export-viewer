// SPDX-License-Identifier: AGPL-3.0-or-later
// Save names: a message file is its cleaned subject (at most 100 characters)
// plus `.eml`, or `message.eml`; numbered names keep the extension and the
// byte and character bounds.

import { describe, expect, it } from 'vitest';
import { MAX_NAME_BYTES, MAX_NAME_CHARS } from '../../src/shared/filename';
import {
  EML_FALLBACK_NAME,
  EML_SUBJECT_CHARS,
  MAX_SUFFIX,
  candidates,
  emlName,
} from '../../src/main/saves/names';

const bytes = (s: string) => new TextEncoder().encode(s).length;

describe('emlName', () => {
  it('is the cleaned subject plus .eml', () => {
    expect(emlName('Quarterly report')).toBe('Quarterly report.eml');
    expect(emlName('a/b: c')).toBe('a_b_ c.eml');
    expect(emlName('CON')).toBe('_CON.eml');
  });

  it('is message.eml when the subject cleans to nothing', () => {
    for (const subject of ['', '   ', '...', '\u202e\u200b', '-.-']) {
      expect(emlName(subject)).toBe(EML_FALLBACK_NAME);
    }
  });

  it('keeps at most 100 characters of the subject, cut on a character boundary', () => {
    expect(emlName('é'.repeat(150))).toBe('é'.repeat(EML_SUBJECT_CHARS) + '.eml');
    // Four-byte characters: the byte bound cuts first, never inside a character.
    const wide = emlName('😀'.repeat(150));
    expect(wide.endsWith('.eml')).toBe(true);
    expect(Buffer.from(wide, 'utf8').toString('utf8')).toBe(wide);
    expect(bytes(wide)).toBeLessThanOrEqual(MAX_NAME_BYTES);
  });

  it('a subject cut to end in a dot or a space loses it', () => {
    const subject = 'x'.repeat(99) + '. tail';
    expect(emlName(subject)).toBe('x'.repeat(99) + '.eml');
  });
});

describe('candidates', () => {
  it('tries the name, then " (2)" up to the last number, before the extension', () => {
    const all = [...candidates('photo.jpg')];
    expect(all.slice(0, 3)).toEqual(['photo.jpg', 'photo (2).jpg', 'photo (3).jpg']);
    expect(all).toHaveLength(MAX_SUFFIX);
    expect(all.at(-1)).toBe(`photo (${MAX_SUFFIX}).jpg`);
  });

  it('every numbered name of a long multibyte name stays within the bounds', () => {
    const name = 'ж'.repeat(127) + '.longextension12';
    for (const candidate of candidates(name)) {
      expect(bytes(candidate)).toBeLessThanOrEqual(MAX_NAME_BYTES);
      expect([...candidate].length).toBeLessThanOrEqual(MAX_NAME_CHARS);
      expect(candidate.endsWith('.longextension12')).toBe(true);
    }
  });
});
