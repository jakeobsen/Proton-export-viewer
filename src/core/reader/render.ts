// SPDX-License-Identifier: AGPL-3.0-or-later
// Renders one message for the reader: reads it within the reader's ceilings
// and builds the body document and the header fields shown with it.
// - An HTML body over HTML_VIEW_BYTES opens as plain text, and the open says
//   so, so the shell can offer to show the HTML anyway; asked for that way,
//   HTML is shown up to HTML_ANYWAY_BYTES.
// - A body over HTML_ANYWAY_BYTES shows only the first FIRST_TEXT_BYTES of
//   its plain text.

import type { Readable } from 'node:stream';
import type { AddressObject, HeaderLines, HeaderValue, Headers } from 'mailparser';
import type { MessageHeaders, OpenMode, RenderedMessage } from '../../shared/reader-protocol';
import { htmlTextParser } from '../text/html-to-text';
import { KEEP_BYTES, extractMessage, type Body } from './extract';
import { plainBody } from './plain';
import { sanitizeHtml } from './sanitize';

/** HTML bodies larger than this, in encoded bytes, open as plain text unless asked for anyway. */
export const HTML_VIEW_BYTES = 5 * 1024 * 1024;
/** Larger bodies are never shown as HTML, and their plain text is cut. */
export const HTML_ANYWAY_BYTES = KEEP_BYTES;
/** How much plain text, in UTF-8 bytes, a body over HTML_ANYWAY_BYTES shows. */
export const FIRST_TEXT_BYTES = 1024 * 1024;

/** The longest subject passed on, in characters. */
export const MAX_SUBJECT = 2000;
/** The longest address list passed on, in characters. */
export const MAX_ADDRESSES = 20000;

export interface RenderOptions {
  mode: OpenMode;
  /** `mail-asset://v/<token>` of the view being opened. */
  assetBase: string;
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function isAddressObject(value: unknown): value is AddressObject {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { text?: unknown }).text === 'string'
  );
}

function addresses(value: HeaderValue | undefined): string {
  const list = Array.isArray(value) ? value : [value];
  const text = list
    .filter(isAddressObject)
    .map((a) => a.text)
    .filter((t) => t.length > 0)
    .join(', ');
  return cut(text, MAX_ADDRESSES);
}

/**
 * The Date header as ISO 8601, or null. Read from the raw line: the parsed
 * header holds the current time when the value isn't a valid date.
 */
function dateField(lines: HeaderLines | null): string | null {
  const line = lines?.find((l) => l.key === 'date')?.line;
  if (line === undefined) return null;
  const value = line
    .slice(line.indexOf(':') + 1)
    .replace(/\r?\n[ \t]+/g, ' ')
    .trim();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** The header fields shown with a message, as plain strings. */
export function headerFields(headers: Headers | null, lines: HeaderLines | null): MessageHeaders {
  const subject = headers?.get('subject');
  return {
    subject: typeof subject === 'string' ? cut(subject, MAX_SUBJECT) : '',
    from: addresses(headers?.get('from')),
    to: addresses(headers?.get('to')),
    cc: addresses(headers?.get('cc')),
    date: dateField(lines),
  };
}

/** Tidies extracted HTML text for display: no trailing blanks, at most one empty line in a row. */
function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The first `max` UTF-8 bytes of `text`, cut on a character boundary. */
export function firstBytes(text: string, max: number): string {
  // Every character takes at least one byte: the first `max` characters hold the cut.
  const head = text.length > max ? text.slice(0, max) : text;
  const bytes = Buffer.from(head);
  if (bytes.length <= max) return head;
  let cut = max;
  while (cut > 0 && ((bytes[cut] ?? 0) & 0xc0) === 0x80) cut -= 1;
  return bytes.subarray(0, cut).toString('utf8');
}

/** The text of an HTML body, stopping once `max` characters are found (no limit if null). */
function textOfHtml(html: string, max: number | null): string {
  const parts: string[] = [];
  let length = 0;
  const parser = htmlTextParser((text) => {
    parts.push(text);
    length += text.length;
  });
  const step = 64 * 1024;
  for (let at = 0; at < html.length && (max === null || length < max); at += step) {
    parser.write(html.slice(at, at + step));
  }
  parser.end();
  return parts.join('');
}

/** The plain text shown for a message, and whether it is only the first part of it. */
function plainText(text: Body, html: Body): { text: string; cut: boolean } {
  const source = text.content.length > 0 || text.cut ? text : html;
  const cut = source.bytes > HTML_ANYWAY_BYTES;
  let content = source.content;
  if (source === html) {
    // Text from HTML: twice the bytes shown is more than enough characters to cut from.
    content = tidy(textOfHtml(html.content, cut ? 2 * FIRST_TEXT_BYTES : null));
  }
  return { text: cut ? firstBytes(content, FIRST_TEXT_BYTES) : content, cut };
}

/**
 * Renders a message: its HTML body sanitized, when HTML is asked for, the
 * message has one, and it is within the ceiling for the mode; or else its
 * plain text: the text part, or the text of the HTML part when there is none.
 */
export async function renderMessage(
  input: Readable,
  options: RenderOptions,
): Promise<RenderedMessage> {
  const { headers: parsedHeaders, lines, text, html } = await extractMessage(input);
  const headers = headerFields(parsedHeaders, lines);
  const hasHtml = html.content.length > 0 || html.cut;
  const htmlLimit = options.mode === 'html-anyway' ? HTML_ANYWAY_BYTES : HTML_VIEW_BYTES;
  if (options.mode !== 'plain' && hasHtml && html.bytes <= htmlLimit) {
    const body = sanitizeHtml(html.content, options.assetBase);
    return {
      headers,
      html: body.html,
      links: body.links,
      format: 'html',
      remote: body.remote,
      hasHtml,
      htmlTooLarge: false,
      truncated: false,
    };
  }
  const plain = plainText(text, html);
  const body = plainBody(plain.text, options.assetBase);
  return {
    headers,
    html: body.html,
    links: body.links,
    format: 'plain',
    remote: 0,
    hasHtml,
    // HTML was asked for and not shown for its size alone: it can be shown anyway.
    htmlTooLarge:
      options.mode === 'html' &&
      hasHtml &&
      html.bytes > HTML_VIEW_BYTES &&
      html.bytes <= HTML_ANYWAY_BYTES,
    truncated: plain.cut,
  };
}
