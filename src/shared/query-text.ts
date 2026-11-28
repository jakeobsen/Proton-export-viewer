// SPDX-License-Identifier: AGPL-3.0-or-later
// How search text is read, shared by core's parser, main's checks and the
// shell: the cleaning every query gets, and what counts as a word.

import { MAX_QUERY_LENGTH } from './index-types';

/**
 * Characters the full-text tokenizer keeps in a word: letters, digits,
 * combining marks and private-use characters. Everything else separates words.
 */
const WORD_CHARS = /[\p{L}\p{N}\p{M}\p{Co}]+/gu;
const MARK = /\p{M}/gu;

/**
 * Query text as it is read: at most MAX_QUERY_LENGTH units, cut without
 * splitting a surrogate pair. Control characters, unpaired surrogates and the
 * two characters snippets mark matches with become spaces.
 */
export function cleanQuery(raw: string): string {
  let text = raw;
  if (text.length > MAX_QUERY_LENGTH) {
    let end = MAX_QUERY_LENGTH;
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    text = text.slice(0, end);
  }
  return text.replace(
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f-\u009f\ue000\ue001]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
    ' ',
  );
}

/**
 * The words the tokenizer would find in `text`. A run of combining marks
 * alone is no word: the tokenizer removes the marks and leaves nothing to match.
 */
export function wordsOf(text: string): string[] {
  return (text.match(WORD_CHARS) ?? []).filter((word) => word.replace(MARK, '') !== '');
}

/** True if the text holds at least one word the full-text index can match. */
export function hasWord(text: string): boolean {
  return wordsOf(text).length > 0;
}

/** Cleaned text with each run of white space made one space, trimmed. */
export function tidyQuery(raw: string): string {
  return cleanQuery(raw).replace(/\s+/gu, ' ').trim();
}
