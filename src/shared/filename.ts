// SPDX-License-Identifier: AGPL-3.0-or-later
// Attachment file names as the app shows and saves them. A name from a message
// is mail data: it may hold path separators, control and invisible characters,
// names Windows reserves for devices, or be far too long. The cleaned name is
// one path component, no longer than a file system allows, and reads as what
// it is: nothing in it hides or reorders the text around it.

/** The longest cleaned name, in characters. */
export const MAX_NAME_CHARS = 200;
/** The longest cleaned name, in UTF-8 bytes: one path component. */
export const MAX_NAME_BYTES = 255;
/** The name of an attachment whose own name cleans to nothing. */
export const FALLBACK_NAME = 'attachment';

// Control characters: C0, DEL and C1.
const CONTROLS_RE = /\p{Cc}/gu;
// Format characters, which change how the text around them reads or take no
// room: bidi marks, embeddings, overrides and isolates, zero-width characters,
// the word joiner and the byte order mark among them.
const INVISIBLE_RE = /\p{Cf}/gu;
// Path separators, and characters that look like a slash.
const SEPARATORS_RE = /[/\\:\u2215\uff0f]/g;
// Names Windows reserves for devices, whatever their case and extension.
const RESERVED_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
// A final extension: a dot, then 1 to 20 characters that are neither dots nor spaces.
const EXTENSION_RE = /\.[^.\s]{1,20}$/u;

const encoder = new TextEncoder();
const utf8 = (s: string): number => encoder.encode(s).length;

/** At most `chars` characters and `bytes` UTF-8 bytes of `s`, cut between characters. */
function cut(s: string, chars: number, bytes: number): string {
  let out = '';
  let n = 0;
  let size = 0;
  for (const ch of s) {
    const b = utf8(ch);
    if (n + 1 > chars || size + b > bytes) break;
    out += ch;
    n += 1;
    size += b;
  }
  return out;
}

const length = (s: string): number => [...s].length;

/** The final extension of a cleaned name, with its dot, or '' when it has none. */
export function extensionOf(name: string): string {
  const match = EXTENSION_RE.exec(name);
  return match && match.index > 0 ? match[0] : '';
}

/**
 * A name of at most MAX_NAME_CHARS characters and MAX_NAME_BYTES bytes, with
 * `suffix` (such as " (2)") placed before the final extension. The stem is cut
 * to make room, so the extension and the suffix are always kept whole.
 */
export function boundedName(name: string, suffix = ''): string {
  const ext = extensionOf(name);
  const tail = suffix + ext;
  let stem = cut(
    name.slice(0, name.length - ext.length),
    MAX_NAME_CHARS - length(tail),
    MAX_NAME_BYTES - utf8(tail),
  );
  // With nothing after it, a cut stem must not end the name in a dot or a space.
  if (tail === '') stem = stem.replace(/[. ]+$/, '');
  return stem === '' ? `${FALLBACK_NAME}${tail}` : `${stem}${tail}`;
}

/**
 * Cleans a file name from a message: NFC; controls and invisible characters
 * removed; path separators and look-alike slashes made `_`; leading dots and
 * dashes and trailing dots and spaces removed; a name Windows reserves gets a
 * leading `_`; the result is bounded (see `boundedName`). A name that is empty
 * or only dots afterwards becomes FALLBACK_NAME.
 */
export function cleanFilename(raw: string): string {
  let name = raw
    .normalize('NFC')
    .replace(CONTROLS_RE, '')
    .replace(INVISIBLE_RE, '')
    .replace(SEPARATORS_RE, '_');
  name = name.replace(/^[.\-\s]+/, '').replace(/[.\s]+$/, '');
  if (name === '') return FALLBACK_NAME;
  if (RESERVED_RE.test(name)) name = `_${name}`;
  return boundedName(name);
}
