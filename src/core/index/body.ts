// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 2 reads each message file once, as a stream, for the full-text index:
// the text of its body and the names of its attachments, within hard limits.
//
// Body parts are chosen by the reader's rules (text/plain, text/html and
// message/delivery-status parts that aren't attachments; embedded messages
// are one part). Inside a multipart/alternative only the first text part is
// read. Text parts are decoded as they stream (transfer encoding, then
// charset), and HTML goes through the streaming HTML-to-text parser. Every
// other part is drained without being kept; for an attachment only its
// decoded size is counted.
//
// Limits: at most RAW_TEXT_BYTES of encoded text is read and at most
// STORED_TEXT_BYTES of UTF-8 text is kept (with LF line breaks), cut on a
// character boundary; past either, the body is truncated. Attachments are
// listed in MIME order: each name, MIME type and content ID is cut to
// NAME_UNITS UTF-16 units, and a message keeps at most MAX_ATTACHMENTS rows
// and ATTACHMENT_BYTES of attachment data. The first part that would pass
// either limit ends the list. A message past the parser's own limits (more
// than MAX_MIME_PARTS parts, or a header block over 2 MiB) is read up to there:
// its body counts as truncated and its list as cut. The two characters
// snippets mark matches with are removed from all of it.

import type { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Splitter, type MimeNode } from '@zone-eu/mailsplit';
import iconv from 'iconv-lite';
import { stripMarks } from '../search/ranges';
import { MAX_HEAD_BYTES, MAX_MIME_PARTS } from '../mime-limits';
import { htmlTextParser } from '../text/html-to-text';

/** Encoded bytes of text parts read for one message. */
export const RAW_TEXT_BYTES = 16 * 1024 * 1024;
/** UTF-8 bytes of body text kept for one message. */
export const STORED_TEXT_BYTES = 1024 * 1024;
/** UTF-16 units kept of an attachment's name, MIME type or content ID. */
export const NAME_UNITS = 255;
/** Attachment rows kept for one message. */
export const MAX_ATTACHMENTS = 1000;
/**
 * Attachment data kept for one message: the UTF-8 bytes of every kept row's
 * name, MIME type and content ID, plus the names' text for the full-text index.
 */
export const ATTACHMENT_BYTES = 256 * 1024;

export interface ExtractLimits {
  rawText: number;
  storedText: number;
  attachments: number;
  attachmentBytes: number;
}

export const LIMITS: ExtractLimits = {
  rawText: RAW_TEXT_BYTES,
  storedText: STORED_TEXT_BYTES,
  attachments: MAX_ATTACHMENTS,
  attachmentBytes: ATTACHMENT_BYTES,
};

export interface AttachmentRow {
  name: string;
  mime: string;
  contentId: string;
  /** Decoded bytes. */
  size: number;
}

export interface BodyText {
  /** The body's text, with LF line breaks. */
  body: string;
  /** True if a text limit cut the body. */
  truncated: boolean;
  attachments: AttachmentRow[];
  /** The kept attachments' names, joined by line breaks. */
  attachmentText: string;
  /** True if an attachment limit ended the list. */
  attachmentsCapped: boolean;
  /** Encoded bytes of text parts read. */
  rawTextBytes: number;
  /** Every byte read from the file. */
  inputBytes: number;
}

/** A streaming base64 decoder: keeps at most three characters between chunks. */
export class Base64Decoder {
  private carry = '';
  write(chunk: Buffer): Buffer {
    const s = this.carry + chunk.toString('latin1').replace(/[^A-Za-z0-9+/]/g, '');
    const whole = s.length - (s.length % 4);
    this.carry = s.slice(whole);
    return Buffer.from(s.slice(0, whole), 'base64');
  }
  end(): Buffer {
    const rest = Buffer.from(this.carry, 'base64');
    this.carry = '';
    return rest;
  }
}

/** A streaming quoted-printable decoder: keeps at most an unfinished escape between chunks. */
export class QuotedPrintableDecoder {
  private carry = '';
  write(chunk: Buffer): Buffer {
    let s = this.carry + chunk.toString('latin1');
    const tail = /=(?:[0-9A-Fa-f]?|\r)$/.exec(s);
    this.carry = tail ? tail[0] : '';
    if (tail) s = s.slice(0, tail.index);
    return QuotedPrintableDecoder.decode(s);
  }
  end(): Buffer {
    const rest = QuotedPrintableDecoder.decode(this.carry);
    this.carry = '';
    return rest;
  }
  static decode(s: string): Buffer {
    const out = s
      .replace(/[ \t]*=\r?\n/g, '')
      .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    return Buffer.from(out, 'latin1');
  }
}

class PassDecoder {
  write(chunk: Buffer): Buffer {
    return chunk;
  }
  end(): Buffer {
    return Buffer.alloc(0);
  }
}

type TransferDecoder = Base64Decoder | QuotedPrintableDecoder | PassDecoder;

function transferDecoder(encoding: string | false): TransferDecoder {
  if (encoding === 'base64') return new Base64Decoder();
  if (encoding === 'quoted-printable') return new QuotedPrintableDecoder();
  return new PassDecoder();
}

function charsetDecoder(charset: string | false): iconv.DecoderStream {
  const name = typeof charset === 'string' ? charset.trim().toLowerCase() : '';
  const known = name !== '' && name !== 'us-ascii' && iconv.encodingExists(name);
  return iconv.getDecoder(known ? name : 'utf-8');
}

/** Base64 alphabet bytes, which alone carry data. */
const BASE64_DATA = new Uint8Array(256);
for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/') {
  BASE64_DATA[c.charCodeAt(0)] = 1;
}

/** Counts an attachment's decoded bytes without keeping them. */
class SizeCounter {
  private base64 = 0;
  private bytes = 0;
  private readonly qp: QuotedPrintableDecoder | null;
  constructor(private readonly encoding: string | false) {
    this.qp = encoding === 'quoted-printable' ? new QuotedPrintableDecoder() : null;
  }
  add(chunk: Buffer): void {
    if (this.encoding === 'base64') {
      let n = 0;
      for (let i = 0; i < chunk.length; i += 1) n += BASE64_DATA[chunk[i]!]!;
      this.base64 += n;
    } else if (this.qp) {
      this.bytes += this.qp.write(chunk).length;
    } else {
      this.bytes += chunk.length;
    }
  }
  total(): number {
    if (this.encoding === 'base64') return Math.floor((this.base64 * 3) / 4);
    return this.bytes + (this.qp ? this.qp.end().length : 0);
  }
}

/**
 * Collects text up to the stored-text limit, in UTF-8 bytes with LF line
 * breaks, cut on a character boundary.
 */
class TextSink {
  private readonly parts: string[] = [];
  bytes = 0;
  full = false;
  /** The last text added ended with a CR, whose LF may start the next. */
  private cr = false;
  /** The last character kept, to keep parts on lines of their own. */
  private last = '\n';
  constructor(private readonly cap: number) {}

  /** Starts a new line, unless the text kept so far ends one. */
  newline(): void {
    if (this.last !== '\n') this.add('\n');
  }

  add(raw: string): void {
    if (this.full || raw.length === 0) return;
    let s = stripMarks(raw);
    if (this.cr && s.startsWith('\n')) s = s.slice(1);
    if (s.length === 0) return;
    this.cr = s.endsWith('\r');
    s = s.replace(/\r\n?/g, '\n');
    this.last = s[s.length - 1]!;
    const n = Buffer.byteLength(s);
    if (this.bytes + n <= this.cap) {
      this.parts.push(s);
      this.bytes += n;
      return;
    }
    const buf = Buffer.from(s);
    let cut = this.cap - this.bytes;
    while (cut > 0 && (buf[cut]! & 0xc0) === 0x80) cut -= 1;
    this.parts.push(buf.subarray(0, cut).toString('utf8'));
    this.bytes += cut;
    this.full = true;
  }
  text(): string {
    return this.parts.join('');
  }
}

/** At most `max` UTF-16 units of `s`, never ending between the halves of a surrogate pair. */
export function cutUnits(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const last = s.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

const utf8 = (s: string): number => Buffer.byteLength(s);

/** The attachment rows of one message, within the row and byte limits. */
class AttachmentList {
  readonly rows: AttachmentRow[] = [];
  private readonly names: string[] = [];
  private bytes = 0;
  capped = false;
  constructor(private readonly limits: ExtractLimits) {}

  /** The row for this part, or null once a limit has ended the list. */
  offer(node: MimeNode): AttachmentRow | null {
    if (this.capped) return null;
    const row: AttachmentRow = {
      name: cutUnits(stripMarks(node.filename || ''), NAME_UNITS),
      mime: cutUnits(stripMarks(node.contentType || ''), NAME_UNITS),
      contentId: cutUnits(stripMarks(contentIdOf(node)), NAME_UNITS),
      size: 0,
    };
    // The row's own strings, and what its name adds to the joined names.
    let add = utf8(row.name) + utf8(row.mime) + utf8(row.contentId);
    if (row.name !== '') add += utf8(row.name) + (this.names.length > 0 ? 1 : 0);
    if (
      this.rows.length + 1 > this.limits.attachments ||
      this.bytes + add > this.limits.attachmentBytes
    ) {
      this.capped = true;
      return null;
    }
    this.rows.push(row);
    if (row.name !== '') this.names.push(row.name);
    this.bytes += add;
    return row;
  }

  text(): string {
    return this.names.join('\n');
  }
}

/** The part's content ID without its angle brackets; empty if it has none. */
function contentIdOf(node: MimeNode): string {
  const value = node.headers ? node.headers.getFirst('content-id') : '';
  if (typeof value !== 'string') return '';
  return value.trim().replace(/^<([^>]*)>$/, '$1');
}

/** Content types read as body text, as the reader reads them. */
const TEXT_TYPES = new Set(['text/plain', 'text/html', 'message/delivery-status']);

/** True for a part read as body text: the reader's rule for a body part. */
export function isBodyText(node: MimeNode): boolean {
  if (node.multipart) return false;
  const contentType = node.contentType || (node.root ? 'text/plain' : '');
  if (!TEXT_TYPES.has(contentType)) return false;
  // Any disposition other than inline (none counts as inline) makes it an attachment.
  return !node.disposition || node.disposition === 'inline';
}

/** True for a part listed as an attachment: an attachment disposition or a filename. */
export function isAttachment(node: MimeNode): boolean {
  if (node.multipart) return false;
  return node.disposition === 'attachment' || Boolean(node.filename);
}

interface TextPart {
  transfer: TransferDecoder;
  charset: iconv.DecoderStream;
  html: ReturnType<typeof htmlTextParser> | null;
  node: MimeNode;
}

interface AttachmentPart {
  row: AttachmentRow;
  counter: SizeCounter;
}

type SplitChunk = MimeNode | { type: 'data' | 'body' | 'none'; value?: Buffer };

/** The multipart/alternative parts that hold the node, nearest first. */
function alternatives(node: MimeNode): object[] {
  const out: object[] = [];
  for (let p = node.parentNode; p !== false; p = p.parentNode) {
    if (p.multipart === 'alternative') out.push(p);
  }
  return out;
}

/** Reads one message for the full-text index; see the top of this file. */
export async function extractBody(
  input: Readable,
  limits: ExtractLimits = LIMITS,
): Promise<BodyText> {
  const sink = new TextSink(limits.storedText);
  const list = new AttachmentList(limits);
  const splitter = new Splitter({
    maxHeadSize: MAX_HEAD_BYTES,
    maxChildNodes: MAX_MIME_PARTS,
    ignoreEmbedded: true,
  });
  // Alternatives whose first text part has been read.
  const answered = new WeakSet<object>();
  let text: TextPart | null = null;
  let attachment: AttachmentPart | null = null;
  let rawUsed = 0;
  let rawCapped = false;
  let inputBytes = 0;
  // The parser stopped at one of its limits: the rest of the file is unread.
  let stopped = false;

  const emit = (part: TextPart, bytes: Buffer) => {
    if (bytes.length === 0) return;
    const decoded = part.charset.write(bytes);
    if (part.html) part.html.write(decoded);
    else sink.add(decoded);
  };

  const finish = () => {
    if (attachment) {
      attachment.row.size = attachment.counter.total();
      attachment = null;
    }
    if (!text) return;
    const part = text;
    text = null;
    emit(part, part.transfer.end());
    const tail = part.charset.end();
    if (tail) {
      if (part.html) part.html.write(tail);
      else sink.add(tail);
    }
    part.html?.end();
    sink.newline();
    for (const alt of alternatives(part.node)) answered.add(alt);
  };

  const count = async function* (source: AsyncIterable<Buffer>) {
    for await (const chunk of source) {
      inputBytes += chunk.length;
      yield chunk;
    }
  };

  // Only the splitter's own limit error ends the read early. The input's
  // errors and the reader's own reach the splitter too, as the pipeline
  // passes them on, so each is told apart by where it was raised first.
  const raisedElsewhere = new WeakSet<object>();
  const noteElsewhere = (err: unknown) => {
    if (typeof err === 'object' && err !== null) raisedElsewhere.add(err);
  };
  input.on('error', noteElsewhere);
  let splitterLimit: unknown = null;
  // The splitter's types name only its data events; it is a Transform stream.
  (splitter as Transform).on('error', (err: unknown) => {
    const code = (err as { code?: unknown } | null)?.code;
    if (splitterLimit === null && code === 'EMAXLEN' && !raisedElsewhere.has(err as object)) {
      splitterLimit = err;
    }
  });

  const consume = async (source: AsyncIterable<SplitChunk>): Promise<void> => {
    for await (const chunk of source) {
      if (chunk.type === 'node') {
        finish();
        const node = chunk as MimeNode;
        if (isAttachment(node)) {
          const row = list.offer(node);
          if (row) attachment = { row, counter: new SizeCounter(node.encoding) };
        }
        const later = alternatives(node).some((alt) => answered.has(alt));
        if (isBodyText(node) && !later && !rawCapped && !sink.full) {
          text = {
            transfer: transferDecoder(node.encoding),
            charset: charsetDecoder(node.charset),
            html: null,
            node,
          };
          if (node.contentType === 'text/html') {
            text.html = htmlTextParser((t) => sink.add(t));
          }
        }
        continue;
      }
      if (chunk.type !== 'body' || !('value' in chunk) || !chunk.value) continue;
      attachment?.counter.add(chunk.value);
      if (!text || sink.full || rawCapped) continue;
      let value = chunk.value;
      const room = limits.rawText - rawUsed;
      if (value.length > room) {
        value = value.subarray(0, room);
        rawCapped = true;
      }
      rawUsed += value.length;
      emit(text, text.transfer.write(value));
    }
    finish();
  };
  const read = pipeline(input, count, splitter, async (source: AsyncIterable<SplitChunk>) => {
    try {
      await consume(source);
    } catch (err) {
      noteElsewhere(err);
      throw err;
    }
  });
  try {
    await read;
  } catch (err) {
    if (splitterLimit === null || err !== splitterLimit) throw err;
    stopped = true;
    finish();
  }

  return {
    body: sink.text(),
    truncated: rawCapped || sink.full || stopped,
    attachments: list.rows,
    attachmentText: list.text(),
    attachmentsCapped: list.capped || stopped,
    rawTextBytes: rawUsed,
    inputBytes,
  };
}
