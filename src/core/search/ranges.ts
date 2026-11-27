// SPDX-License-Identifier: AGPL-3.0-or-later
// Match marks to ranges. SQLite's snippet() and highlight() wrap each match in
// U+E000 and U+E001, two private-use characters the index strips from the
// text it stores. Core turns the marked text into plain text and match ranges
// in UTF-16 code units, and checks the ranges before any are given out.

export const MARK_START = '\ue000';
export const MARK_END = '\ue001';

export type Range = [number, number];

export interface MarkedText {
  text: string;
  ranges: Range[];
}

/** Removes the two mark characters from text the index stores. */
export function stripMarks(text: string): string {
  return text.replace(/[\ue000\ue001]/g, '');
}

/** True if index `i` of `text` is between the two halves of a surrogate pair. */
function splitsPair(text: string, i: number): boolean {
  if (i <= 0 || i >= text.length) return false;
  const before = text.charCodeAt(i - 1);
  const after = text.charCodeAt(i);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/**
 * True if the ranges are ascending, non-overlapping, non-empty, inside the
 * text, and none starts or ends inside a surrogate pair.
 */
export function validRanges(text: string, ranges: readonly Range[]): boolean {
  let floor = 0;
  for (const range of ranges) {
    if (!Array.isArray(range) || range.length !== 2) return false;
    const [start, end] = range;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return false;
    if (start < floor || end <= start || end > text.length) return false;
    if (splitsPair(text, start) || splitsPair(text, end)) return false;
    floor = end;
  }
  return true;
}

/**
 * Converts marked text to plain text and match ranges. Null when the marks
 * don't pair up or the ranges fail the check; the caller drops that text's
 * marks and counts it.
 */
export function markedToRanges(marked: string): MarkedText | null {
  let text = '';
  const ranges: Range[] = [];
  let open: number | null = null;
  let last = 0;
  for (let i = 0; i < marked.length; i += 1) {
    const ch = marked[i];
    if (ch !== MARK_START && ch !== MARK_END) continue;
    text += marked.slice(last, i);
    last = i + 1;
    if (ch === MARK_START) {
      if (open !== null) return null;
      open = text.length;
    } else {
      if (open === null) return null;
      if (text.length > open) ranges.push([open, text.length]);
      open = null;
    }
  }
  if (open !== null) return null;
  text += marked.slice(last);
  return validRanges(text, ranges) ? { text, ranges } : null;
}
