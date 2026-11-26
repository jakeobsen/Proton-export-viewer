// SPDX-License-Identifier: AGPL-3.0-or-later
// Renders one message for the reader: parses it with mailparser and builds the
// body document and the header fields shown with it.

import type { Readable } from 'node:stream';
import {
  MailParser,
  type AddressObject,
  type HeaderLines,
  type HeaderValue,
  type Headers,
} from 'mailparser';
import type { MessageHeaders, OpenMode, RenderedMessage } from '../../shared/reader-protocol';
import { htmlToText } from '../text/html-to-text';
import { plainBody } from './plain';

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

interface Parsed {
  headers: Headers | null;
  lines: HeaderLines | null;
  text: string;
  html: string;
}

function parse(input: Readable): Promise<Parsed> {
  const parser = new MailParser({
    skipHtmlToText: true,
    skipTextToHtml: true,
    skipTextLinks: true,
    skipImageLinks: true,
    checksumAlgo: false,
  });
  const parsed: Parsed = { headers: null, lines: null, text: '', html: '' };
  return new Promise((resolve, reject) => {
    parser.on('headers', (headers: Headers) => {
      parsed.headers = headers;
    });
    parser.on('headerLines', (lines: HeaderLines) => {
      parsed.lines = lines;
    });
    parser.on('data', (data) => {
      if (data.type === 'attachment') {
        // Attachments are not shown here: drain each one so parsing goes on.
        data.content.on('end', () => data.release?.());
        data.content.resume();
        return;
      }
      parsed.text = data.text ?? '';
      parsed.html = data.html ?? '';
    });
    parser.once('end', () => resolve(parsed));
    parser.once('error', reject);
    input.once('error', reject);
    input.pipe(parser);
  });
}

/**
 * Renders a message. Bodies are plain text for now: the text part, or the
 * text of the HTML part when there is none.
 */
export async function renderMessage(
  input: Readable,
  options: RenderOptions,
): Promise<RenderedMessage> {
  const parsed = await parse(input);
  const hasHtml = parsed.html.length > 0;
  const text = parsed.text.length > 0 ? parsed.text : hasHtml ? tidy(htmlToText(parsed.html)) : '';
  const body = plainBody(text, options.assetBase);
  return {
    headers: headerFields(parsed.headers, parsed.lines),
    html: body.html,
    links: body.links,
    format: 'plain',
    hasHtml,
  };
}
