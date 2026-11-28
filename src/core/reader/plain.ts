// SPDX-License-Identifier: AGPL-3.0-or-later
// Plain text bodies: escaped, with absolute http, https and mailto URLs turned
// into links. A link's href is an opaque id under the view's asset base
// (`<assetBase>/l<n>`), so no URL or host name is ever an href in the body.
// A body from search also marks its matches: links are found first, on the
// text as it is, and the marks then go inside and around them.

import type { BodyLink } from '../../shared/reader-protocol';

/** The most links one body gets; further URLs stay plain text. */
export const MAX_LINKS = 5000;
/** Longer URLs stay plain text. */
export const MAX_URL_LENGTH = 8192;
/** The most matches marked in one body; the rest of its text is shown unmarked. */
export const MAX_MARKS = 10000;

const LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:']);
const CANDIDATE_RE = /\b(?:https?:\/\/|mailto:)[^\s<>"'`]+/gi;
const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const STYLE = [
  'html{color-scheme:light dark}',
  'body{margin:0;padding:16px;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
  'pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}',
].join('');
/** Added only to a body with marks, so a body without any stays as it was. */
const MARK_STYLE = [
  'mark{background:#ffe56b;color:#1c1b23;border-radius:2px;padding:0 1px}',
  '@media (prefers-color-scheme:dark){mark{background:#6f5c12;color:#fff7d6}}',
].join('');

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

function count(text: string, char: string): number {
  let n = 0;
  for (const c of text) if (c === char) n += 1;
  return n;
}

/** Drops punctuation that ends the sentence rather than the URL. */
export function trimUrl(candidate: string): string {
  let url = candidate;
  for (;;) {
    const last = url.at(-1);
    if (last === undefined) return url;
    if ('.,;:!?\'"'.includes(last)) {
      url = url.slice(0, -1);
      continue;
    }
    const open = ({ ')': '(', ']': '[', '}': '{' } as Record<string, string>)[last];
    if (open && count(url, open) < count(url, last)) {
      url = url.slice(0, -1);
      continue;
    }
    return url;
  }
}

/** The normalized URL a link may point at, or null if it may not be a link. */
export function linkUrl(text: string): string | null {
  if (text.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (!LINK_SCHEMES.has(url.protocol)) return null;
  if (url.protocol === 'mailto:' ? url.pathname === '' : url.hostname === '') return null;
  return url.href;
}

/** Wraps body markup in the document mail-body: serves for plain text. */
export function plainDocument(inner: string, marked = false): string {
  const style = marked ? STYLE + MARK_STYLE : STYLE;
  return `<!doctype html><html><head><style>${style}</style></head><body><pre>${inner}</pre></body></html>`;
}

/**
 * Escapes `source` from `from` to `to`, with the parts inside `ranges`
 * wrapped in `<mark>`, each piece escaped on its own. `ranges` are ascending
 * and don't overlap; `next` is the first one not yet used up, and a range
 * that runs past `to` is left for the following slice.
 */
function markedSlice(
  source: string,
  from: number,
  to: number,
  ranges: ReadonlyArray<readonly [number, number]>,
  next: { i: number },
): string {
  let out = '';
  let at = from;
  while (next.i < ranges.length && ranges[next.i]![1] <= from) next.i += 1;
  while (next.i < ranges.length && ranges[next.i]![0] < to) {
    const [start, end] = ranges[next.i]!;
    const s = Math.max(start, from);
    const e = Math.min(end, to);
    if (s > at) out += escapeHtml(source.slice(at, s));
    out += `<mark>${escapeHtml(source.slice(s, e))}</mark>`;
    at = e;
    if (end > to) break;
    next.i += 1;
  }
  if (at < to) out += escapeHtml(source.slice(at, to));
  return out;
}

/**
 * The plain text body document of `text`, and its links. `ranges` mark
 * matches: UTF-16 ranges of `text`, ascending, not overlapping, and not
 * splitting a surrogate pair; at most MAX_MARKS of them are drawn. A link
 * found across a mark's edge splits the mark, so the markup nests.
 */
export function plainBody(
  text: string,
  assetBase: string,
  ranges: ReadonlyArray<readonly [number, number]> = [],
): { html: string; links: BodyLink[] } {
  const source = text.replace(/\r\n?/g, '\n');
  const marks = ranges.slice(0, MAX_MARKS);
  const next = { i: 0 };
  const base = escapeHtml(assetBase);
  const links: BodyLink[] = [];
  let out = '';
  let last = 0;
  for (const match of source.matchAll(CANDIDATE_RE)) {
    if (links.length >= MAX_LINKS) break;
    const raw = trimUrl(match[0]);
    const url = linkUrl(raw);
    if (url === null) continue;
    const id = `l${links.length + 1}`;
    links.push({ id, url, text: raw });
    const end = match.index + raw.length;
    out += markedSlice(source, last, match.index, marks, next);
    out += `<a href="${base}/${id}" target="_blank" rel="noopener noreferrer">${markedSlice(source, match.index, end, marks, next)}</a>`;
    last = end;
  }
  out += markedSlice(source, last, source.length, marks, next);
  return { html: plainDocument(out, marks.length > 0), links };
}
