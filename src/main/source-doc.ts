// SPDX-License-Identifier: AGPL-3.0-or-later
// The source view's header document: a raw header block shown as inert text
// in the body frame, under the body's CSP. Every character that could hide
// or reorder text, or take no room, shows as a visible escape instead.

/** The note above a header block that was cut to the source view's cap. */
export const CUT_NOTE = 'First 256 KB shown';

/**
 * Characters shown as `<U+…>` escapes: controls, format characters (bidi
 * marks, embeddings, overrides and isolates, zero-width characters, tag
 * characters…), line and paragraph separators, and every default-ignorable
 * code point (soft hyphen, variation selectors…). Tab and line feed are the
 * header block's own layout and stay.
 */
const HIDDEN_RE = /(?![\t\n])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu;

/** A header field's name at the start of a line: printable ASCII up to the colon. */
const FIELD_NAME_RE = /^([!-9;-~]+):/;

const decoder = new TextDecoder('utf-8', { fatal: false });

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** `<U+202E>` for one code point. */
function codePoint(ch: string): string {
  return `<U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}>`;
}

/**
 * The block as text: decoded as UTF-8 (an invalid sequence becomes U+FFFD),
 * CRLF as LF, and every hidden character as its escape. This is the text the
 * document shows, and what Copy headers copies.
 */
export function headerText(bytes: Uint8Array): string {
  return decoder.decode(bytes).replace(/\r\n/g, '\n').replace(HIDDEN_RE, codePoint);
}

/** The document for one header block, and the text it shows. */
export function headerDocument(
  bytes: Uint8Array,
  truncated: boolean,
): { html: string; text: string } {
  const text = headerText(bytes);
  const lines = text.split('\n').map((line) => {
    // Escapes were made before HTML escaping: mark them after it.
    const marked = (s: string) =>
      escapeHtml(s).replace(/&lt;U\+[0-9A-F]{4,6}&gt;/g, (m) => `<span class="esc">${m}</span>`);
    const name = FIELD_NAME_RE.exec(line);
    if (!name) return marked(line);
    return `<span class="hn">${marked(name[1]!)}:</span>${marked(line.slice(name[0].length))}`;
  });
  const html =
    '<!doctype html><html><head><meta charset="utf-8"><style>' +
    ':root{color-scheme:light dark}' +
    'body{margin:0;padding:12px 16px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#1c1b23;background:#fff}' +
    'pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}' +
    '.hn{color:#5634e6;font-weight:600}' +
    '.esc{color:#c0262e;background:#fdeeee;border-radius:3px}' +
    '.cut{margin:0 0 8px;color:#7f7e94}' +
    '@media (prefers-color-scheme:dark){body{color:#ecebf2;background:#1c1b22}.hn{color:#b6a6ff}.esc{color:#ff8a90;background:#371b20}.cut{color:#82819a}}' +
    '</style></head><body>' +
    (truncated ? `<p class="cut">${CUT_NOTE}</p>` : '') +
    `<pre>${lines.join('\n')}</pre></body></html>`;
  return { html, text };
}
