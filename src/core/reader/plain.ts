// SPDX-License-Identifier: AGPL-3.0-or-later
// Plain text bodies: escaped, with absolute http, https and mailto URLs turned
// into links. A link's href is an opaque id under the view's asset base
// (`<assetBase>/l<n>`), so no URL or host name is ever an href in the body.

import type { BodyLink } from '../../shared/reader-protocol';

/** The most links one body gets; further URLs stay plain text. */
export const MAX_LINKS = 5000;
/** Longer URLs stay plain text. */
export const MAX_URL_LENGTH = 8192;

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
export function plainDocument(inner: string): string {
  return `<!doctype html><html><head><style>${STYLE}</style></head><body><pre>${inner}</pre></body></html>`;
}

/** The plain text body document of `text`, and its links. */
export function plainBody(text: string, assetBase: string): { html: string; links: BodyLink[] } {
  const source = text.replace(/\r\n?/g, '\n');
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
    out += escapeHtml(source.slice(last, match.index));
    out += `<a href="${base}/${id}" target="_blank" rel="noopener noreferrer">${escapeHtml(raw)}</a>`;
    last = match.index + raw.length;
  }
  out += escapeHtml(source.slice(last));
  return { html: plainDocument(out), links };
}
