// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  MARK_END as E,
  MARK_START as S,
  markedToRanges,
  stripMarks,
  validRanges,
} from '../../src/core/search/ranges';

describe('match ranges', () => {
  it('convert marked text to plain text and UTF-16 ranges', () => {
    expect(markedToRanges(`a ${S}bc${E} d ${S}e${E}`)).toEqual({
      text: 'a bc d e',
      ranges: [
        [2, 4],
        [7, 8],
      ],
    });
    expect(markedToRanges(`${S}😀x${E} y`)).toEqual({ text: '😀x y', ranges: [[0, 3]] });
    expect(markedToRanges('none')).toEqual({ text: 'none', ranges: [] });
    // An empty mark adds no range.
    expect(markedToRanges(`a${S}${E}b`)).toEqual({ text: 'ab', ranges: [] });
  });

  it('refuse marks that do not pair up', () => {
    for (const bad of [`${S}a`, `a${E}`, `${S}${S}a${E}${E}`, `${S}a${E}${E}`, `${E}${S}a`]) {
      expect(markedToRanges(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('check order, overlap, bounds and surrogate pairs', () => {
    const text = 'ab😀cd';
    expect(validRanges(text, [])).toBe(true);
    expect(validRanges(text, [[0, 2]])).toBe(true);
    expect(validRanges(text, [[2, 4]])).toBe(true);
    expect(
      validRanges(text, [
        [0, 1],
        [1, 2],
      ]),
    ).toBe(true);
    expect(
      validRanges(text, [
        [2, 4],
        [0, 1],
      ]),
    ).toBe(false);
    expect(
      validRanges(text, [
        [0, 3],
        [2, 4],
      ]),
    ).toBe(false);
    expect(validRanges(text, [[1, 1]])).toBe(false);
    expect(validRanges(text, [[3, 2]])).toBe(false);
    expect(validRanges(text, [[-1, 1]])).toBe(false);
    expect(validRanges(text, [[4, 7]])).toBe(false);
    expect(validRanges(text, [[0, 1.5]])).toBe(false);
    // Starting or ending between the halves of the emoji.
    expect(validRanges(text, [[3, 4]])).toBe(false);
    expect(validRanges(text, [[2, 3]])).toBe(false);
    expect(validRanges(text, [[1, 3]])).toBe(false);
  });

  it('strip the mark characters from stored text', () => {
    expect(stripMarks(`${S}a${E}b${E}`)).toBe('ab');
    expect(stripMarks('plain ')).toBe('plain ');
  });
});
