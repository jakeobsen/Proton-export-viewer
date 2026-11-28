// SPDX-License-Identifier: AGPL-3.0-or-later
// Renders one message for the reader: reads it within the reader's ceilings
// and builds the body document and the header fields shown with it.
// - An HTML body over HTML_VIEW_BYTES opens as plain text, and the open says
//   so, so the shell can offer to show the HTML anyway; asked for that way,
//   HTML is shown up to HTML_ANYWAY_BYTES.
// - A body over HTML_ANYWAY_BYTES shows only the first FIRST_TEXT_BYTES of
//   its plain text.
// Each limit applies to the body being shown, and counts its encoded bytes
// (before base64 or quoted-printable is undone), so an encoded body counts as
// larger than its decoded text.
// An HTML body comes with its inline images (see images.ts): the `cid:`
// parts it names, read again from the message, and its `data:` images.
// Opened from search, a plain view shows the stored body with its matches
// marked, once the match ranges pass the check again here.

import type { Readable } from 'node:stream';
import type { AddressObject, HeaderLines, HeaderValue, Headers } from 'mailparser';
import { isRisky, typeLabel } from '../../shared/attachment-types';
import { cleanFilename } from '../../shared/filename';
import { headerText } from '../../shared/header-text';
import {
  MAX_REFERENCES,
  type AttachmentEntry,
  type MessageDetails,
  type MessageHeaders,
  type OpenMode,
  type RenderedMessage,
  type StoredBody,
} from '../../shared/reader-protocol';
import { validRanges } from '../search/ranges';
import { htmlTextParser } from '../text/html-to-text';
import { KEEP_BYTES, extractMessage, type Body, type ExtractedMessage } from './extract';
import { InlineImages, type ImageRefusal, type Reread } from './images';
import { plainBody } from './plain';
import { rasterFormat } from './raster';
import { sanitizeHtml, type HtmlSource, type ImageResolver, type SanitizedBody } from './sanitize';

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
  /** What makes the HTML body safe: the sanitizer, unless a test build replaces it. */
  sanitize?: (
    html: readonly HtmlSource[],
    assetBase: string,
    images: ImageResolver,
  ) => SanitizedBody;
  /** How to read the message again for its `cid:` images. Without it, none is shown. */
  reread?: Reread;
  /** Told, once the body is built, how many inline images weren't shown, by reason. */
  onImagesRefused?: (refused: ReadonlyMap<ImageRefusal, number>) => void;
  /** The stored body with its match ranges, shown marked whenever the body is plain text. */
  stored?: StoredBody;
  /** Told how many match ranges were dropped because they failed the check. */
  onMarksDropped?: (count: number) => void;
  /** Told how many attachments got no preview because the read's check budget was spent. */
  onPreviewUnchecked?: (count: number) => void;
  /** The read's preview check budget, in decoded bytes; PREVIEW_CHECK_BYTES unless set. */
  previewCheckBytes?: number;
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

/**
 * The attachment list of a view: every part the index lists as an attachment,
 * in message order, except the parts the shown body displays as images. It
 * has no cap of its own: it holds every attachment read, so each one can be
 * saved, and can be longer than the index's rows, which stop at
 * MAX_ATTACHMENTS. The two agree on the rows the index keeps. An entry's
 * preview is the raster check's result on the whole part, never its
 * declared type.
 */
export function attachmentList(
  extracted: Pick<ExtractedMessage, 'tree' | 'listed'>,
  shown: ReadonlySet<number>,
): AttachmentEntry[] {
  const out: AttachmentEntry[] = [];
  for (const { part, size, head, preview } of extracted.listed) {
    const record = extracted.tree.parts[part];
    if (!record || shown.has(part)) continue;
    const name = cleanFilename(record.filename ?? '');
    const imageFormat = rasterFormat(head);
    out.push({
      path: record.path,
      name,
      contentType: record.contentType,
      label: typeLabel(name, imageFormat),
      size,
      risky: isRisky(name),
      imageFormat,
      preview,
    });
  }
  return out;
}

/** The ids of a Message-ID or References value, each in its angle brackets. */
function messageIds(value: HeaderValue | undefined): string[] {
  const text = (Array.isArray(value) ? value : [value])
    .filter((v): v is string => typeof v === 'string')
    .join(' ');
  return text.match(/<[^<>]*>/g) ?? (text.trim() === '' ? [] : [text.trim()]);
}

/** The structure line of Details, e.g. "multipart/mixed · HTML and plain text · 3 attachments". */
export function formatLine(
  contentType: string,
  bodies: { hasHtml: boolean; hasText: boolean },
  attachments: number,
): string {
  const kinds =
    bodies.hasHtml && bodies.hasText
      ? 'HTML and plain text'
      : bodies.hasHtml
        ? 'HTML'
        : bodies.hasText
          ? 'Plain text'
          : 'No text';
  const count =
    attachments === 0 ? null : attachments === 1 ? '1 attachment' : `${attachments} attachments`;
  return [headerText(contentType) || 'text/plain', kinds, count].filter(Boolean).join(' · ');
}

/** What Details shows beyond the header lines, each value cleaned for display. */
export function detailsOf(
  headers: Headers | null,
  bodies: { hasHtml: boolean; hasText: boolean; attachments: number },
): MessageDetails {
  const contentType = headers?.get('content-type');
  const type =
    typeof contentType === 'object' && contentType !== null && 'value' in contentType
      ? String((contentType as { value: unknown }).value)
      : '';
  const references = messageIds(headers?.get('references'));
  return {
    messageId: headerText(messageIds(headers?.get('message-id'))[0] ?? ''),
    // Only the references shown are cleaned.
    references: references.slice(0, MAX_REFERENCES).map(headerText),
    moreReferences: Math.max(0, references.length - MAX_REFERENCES),
    format: formatLine(type.toLowerCase(), bodies, bodies.attachments),
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
  const long = source.bytes > HTML_ANYWAY_BYTES;
  let content = source.content;
  if (source === html) {
    // Text from HTML: twice the bytes shown is more than enough characters to cut from.
    content = tidy(textOfHtml(html.content, long ? 2 * FIRST_TEXT_BYTES : null));
  }
  return { text: long ? firstBytes(content, FIRST_TEXT_BYTES) : content, cut: long || source.cut };
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
  const extracted = await extractMessage(input, KEEP_BYTES, options.previewCheckBytes);
  const { headers: parsedHeaders, lines, text, html, stopped } = extracted;
  if (extracted.previewUnchecked > 0) options.onPreviewUnchecked?.(extracted.previewUnchecked);
  const headers = headerFields(parsedHeaders, lines);
  const hasHtml = html.content.length > 0 || html.cut;
  const hasText = text.content.length > 0 || text.cut;
  const bodies = { hasHtml, hasText };
  const htmlLimit = options.mode === 'html-anyway' ? HTML_ANYWAY_BYTES : HTML_VIEW_BYTES;
  if (options.mode !== 'plain' && hasHtml && html.bytes <= htmlLimit) {
    const images = new InlineImages(extracted.tree);
    const sources = extracted.htmlParts.map(({ part, start, end }) => ({
      html: html.content.slice(start, end),
      part,
    }));
    const body = (options.sanitize ?? sanitizeHtml)(sources, options.assetBase, images);
    const served = await images.load(body.cidTargets, options.reread ?? null);
    if (images.refused.size > 0) options.onImagesRefused?.(images.refused);
    // A part the body shows as an image isn't listed again.
    const attachments = attachmentList(extracted, images.shown);
    const details = detailsOf(parsedHeaders, { ...bodies, attachments: attachments.length });
    return {
      headers,
      attachments,
      details,
      html: body.html,
      links: body.links,
      format: 'html',
      remote: body.remote,
      cids: body.cids,
      images: served,
      imagesRefused: images.refusedCount,
      hasHtml,
      htmlTooLarge: false,
      cut: stopped ? 'parts' : null,
      highlighted: false,
    };
  }
  const marked = markedStored(options);
  const plain = marked ? null : plainText(text, html);
  const body = marked
    ? plainBody(marked.text, options.assetBase, marked.ranges)
    : plainBody(plain!.text, options.assetBase);
  const attachments = attachmentList(extracted, new Set());
  const details = detailsOf(parsedHeaders, { ...bodies, attachments: attachments.length });
  return {
    headers,
    attachments,
    details,
    html: body.html,
    links: body.links,
    format: 'plain',
    remote: 0,
    cids: 0,
    images: [],
    imagesRefused: 0,
    hasHtml,
    // HTML was asked for and not shown for its size alone: it can be shown anyway.
    htmlTooLarge:
      options.mode === 'html' &&
      hasHtml &&
      html.bytes > HTML_VIEW_BYTES &&
      html.bytes <= HTML_ANYWAY_BYTES,
    // The stored body is the indexed text; how much of it was indexed is the match line's.
    cut: marked ? null : plain!.cut ? 'size' : stopped ? 'parts' : null,
    highlighted: marked !== null,
  };
}

/**
 * The stored body to show marked, or null to show the message's own text.
 * Its ranges are checked again against the exact text the links are found
 * in; if they fail, or that text would change length, the marks go.
 */
function markedStored(options: RenderOptions): StoredBody | null {
  const stored = options.stored;
  if (!stored) return null;
  const same = stored.text.replace(/\r\n?/g, '\n').length === stored.text.length;
  if (same && validRanges(stored.text, stored.ranges)) return stored;
  options.onMarksDropped?.(stored.ranges.length);
  return null;
}
