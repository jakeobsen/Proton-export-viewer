// SPDX-License-Identifier: AGPL-3.0-or-later
// Header values the reader's Details show, such as the Message-ID: mail data
// shown in the shell. Nothing in a value may reorder or hide the text around
// it, a control character shows as what it is, and a value has at most the
// length of one header line.

/** The longest value shown, in characters: the length of one header line. */
export const MAX_HEADER_VALUE = 998;

// Format characters: bidi marks, embeddings, overrides and isolates,
// zero-width characters, the word joiner and the byte order mark among them.
const INVISIBLE_RE = /\p{Cf}/gu;
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
