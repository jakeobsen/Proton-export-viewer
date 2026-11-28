// SPDX-License-Identifier: AGPL-3.0-or-later
// Header text the shell shows: values in the reader's Details, such as the
// Message-ID, and subjects and names in rows and headers. Nothing in a value
// may reorder or hide the text around it, a control character shows as what
// it is, and a value has at most the length of one header line.

/** The longest value shown, in characters: the length of one header line. */
export const MAX_HEADER_VALUE = 998;

// Format characters: bidi marks, embeddings, overrides and isolates, the
// zero-width space, the word joiner, the soft hyphen and the byte order mark
// among them, and the whole tag block, assigned or not. The zero-width
// non-joiner and joiner stay: they shape letters in Persian and Indic scripts
// and join emoji sequences, and they can't reorder or hide the text around
// them.
const INVISIBLE_RE = /(?![\u200c\u200d])[\p{Cf}\u{e0000}-\u{e007f}]/gu;
// White space as a row or a header shows it: any run, line breaks included,
// is one space.
const SPACES_RE = /\s+/gu;
// Control characters, and the line and paragraph separators, which break a
// line as a control does: C0 and DEL show as their symbols from the Control
// Pictures block; C1 and the separators, which have none, as the replacement
// character.
const CONTROLS_RE = /[\p{Cc}\p{Zl}\p{Zp}]/gu;

function picture(ch: string): string {
  const code = ch.charCodeAt(0);
  if (code < 0x20) return String.fromCharCode(0x2400 + code);
  return code === 0x7f ? '\u2421' : '\ufffd';
}

/**
 * A header value as Details shows and copies it: invisible and bidi characters
 * removed, controls and line separators shown as symbols, the ends trimmed, and at most
 * MAX_HEADER_VALUE characters, cut between characters.
 */
export function headerText(raw: string): string {
  const clean = raw.replace(INVISIBLE_RE, '').replace(CONTROLS_RE, picture).trim();
  const chars = [...clean];
  return chars.length <= MAX_HEADER_VALUE
    ? clean
    : `${chars.slice(0, MAX_HEADER_VALUE - 1).join('')}…`;
}

/**
 * A part of a line of mail text, such as one marked or unmarked run of a
 * snippet: invisible and bidi characters removed, each run of white space,
 * line breaks and tabs included, shown as one space, and controls as symbols.
 * Invisible characters go first, so one between two spaces leaves one space.
 * The ends stay as they are, so the parts of a line still join with their
 * spaces.
 */
export function partText(raw: string): string {
  return raw.replace(INVISIBLE_RE, '').replace(SPACES_RE, ' ').replace(CONTROLS_RE, picture);
}

/** A line of mail text, such as a message's first words under its name: partText, trimmed. */
export function lineText(raw: string): string {
  return partText(raw).trim();
}

/**
 * A subject or a name as a row or a header shows it: lineText, cut as
 * headerText cuts a value.
 */
export function displayText(raw: string): string {
  return headerText(lineText(raw));
}
