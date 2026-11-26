// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 2 text extraction from a MIME stream, with hard ceilings. Text parts
// are decoded as they stream (transfer encoding, then charset), HTML goes
// through a streaming parser, and everything else is drained unbuffered.

import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Splitter, type MimeNode } from '@zone-eu/mailsplit';
import { Parser } from 'htmlparser2';
import iconv from 'iconv-lite';
import { BODY_STATE, MARK_END, MARK_START } from './schema';

export const RAW_TEXT_CAP = 16 * 1024 * 1024;
export const STORED_TEXT_CAP = 1024 * 1024;

export interface ExtractCaps {
  rawText: number;
  storedText: number;
}

export interface ExtractResult {
  text: string;
  state: number;
  /** Raw text-part bytes consumed for extraction. */
  rawTextBytes: number;
  /** UTF-8 bytes of the stored text. */
  textBytes: number;
  /** Every byte read from the input. */
  inputBytes: number;
  textParts: number;
}

/** Streaming base64 decoder: keeps at most three characters between chunks. */
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

/** Streaming quoted-printable decoder: keeps at most an unfinished escape between chunks. */
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

const SKIP_TAGS = new Set(['script', 'style', 'head', 'template', 'noscript', 'title']);
const BLOCK_TAGS = new Set([
  'p',
  'br',
  'div',
  'li',
  'tr',
  'td',
  'th',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'pre',
  'table',
  'ul',
  'ol',
  'hr',
  'section',
  'article',
]);

const SENTINELS = new RegExp(`[${MARK_START}${MARK_END}]`, 'g');

/** Collects extracted text up to the stored-text ceiling, in UTF-8 bytes. */
class TextSink {
  private parts: string[] = [];
  bytes = 0;
  full = false;
  constructor(private readonly cap: number) {}
  add(raw: string): void {
    if (this.full || raw.length === 0) return;
    const s = raw.replace(SENTINELS, '');
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

interface ActivePart {
  transfer: Base64Decoder | QuotedPrintableDecoder | PassDecoder;
  charset: iconv.DecoderStream;
  html: Parser | null;
}

function transferDecoder(encoding: string | false) {
  if (encoding === 'base64') return new Base64Decoder();
  if (encoding === 'quoted-printable') return new QuotedPrintableDecoder();
  return new PassDecoder();
}

function charsetDecoder(charset: string | false): iconv.DecoderStream {
  const name = typeof charset === 'string' ? charset.trim().toLowerCase() : '';
  const known = name !== '' && name !== 'us-ascii' && iconv.encodingExists(name);
  return iconv.getDecoder(known ? name : 'utf-8');
}

function htmlParser(sink: TextSink): Parser {
  let skip = 0;
  return new Parser(
    {
      onopentagname(name) {
        if (SKIP_TAGS.has(name)) skip += 1;
        else if (BLOCK_TAGS.has(name)) sink.add('\n');
      },
      onclosetag(name) {
        if (SKIP_TAGS.has(name)) skip = Math.max(0, skip - 1);
        else if (BLOCK_TAGS.has(name)) sink.add('\n');
      },
      ontext(text) {
        if (skip === 0) sink.add(text);
      },
    },
    { decodeEntities: true },
  );
}

type SplitChunk = MimeNode | { type: 'data' | 'body' | 'none'; value?: Buffer };

const isText = (node: MimeNode): boolean =>
  (node.contentType === 'text/plain' || node.contentType === 'text/html') &&
  node.disposition !== 'attachment';

/**
 * Extracts the searchable text of one message. Beyond either ceiling the
 * result is truncated (body_state 2) and the rest of the input is drained.
 */
export async function extractText(
  input: Readable,
  caps: ExtractCaps = { rawText: RAW_TEXT_CAP, storedText: STORED_TEXT_CAP },
): Promise<ExtractResult> {
  const sink = new TextSink(caps.storedText);
  const splitter = new Splitter({ maxHeadSize: 2 * 1024 * 1024 });
  const alternativeDone = new WeakSet<object>();
  let active: ActivePart | null = null;
  let activeNode: MimeNode | null = null;
  let rawUsed = 0;
  let rawCapped = false;
  let inputBytes = 0;
  let textParts = 0;

  const emit = (part: ActivePart, bytes: Buffer) => {
    if (bytes.length === 0) return;
    const text = part.charset.write(bytes);
    if (part.html) part.html.write(text);
    else sink.add(text);
  };

  const finish = () => {
    if (!active) return;
    const part = active;
    emit(part, part.transfer.end());
    const tail = part.charset.end();
    if (tail) {
      if (part.html) part.html.write(tail);
      else sink.add(tail);
    }
    part.html?.end();
    sink.add('\n');
    const parent = activeNode?.parentNode;
    if (parent && parent.multipart === 'alternative') alternativeDone.add(parent);
    active = null;
    activeNode = null;
  };

  const count = async function* (source: AsyncIterable<Buffer>) {
    for await (const chunk of source) {
      inputBytes += chunk.length;
      yield chunk;
    }
  };

  await pipeline(input, count, splitter, async (source: AsyncIterable<SplitChunk>) => {
    for await (const chunk of source) {
      if (chunk.type === 'node') {
        finish();
        const node = chunk as MimeNode;
        const parent = node.parentNode;
        const skipAlternative =
          parent !== false && parent.multipart === 'alternative' && alternativeDone.has(parent);
        if (isText(node) && !skipAlternative && !rawCapped && !sink.full) {
          active = {
            transfer: transferDecoder(node.encoding),
            charset: charsetDecoder(node.charset),
            html: null,
          };
          if (node.contentType === 'text/html') active.html = htmlParser(sink);
          activeNode = node;
          textParts += 1;
        }
        continue;
      }
      if (chunk.type !== 'body' || !active || !('value' in chunk) || !chunk.value) continue;
      if (sink.full || rawCapped) continue;
      let value = chunk.value;
      const room = caps.rawText - rawUsed;
      if (value.length > room) {
        value = value.subarray(0, room);
        rawCapped = true;
      }
      rawUsed += value.length;
      emit(active, active.transfer.write(value));
    }
    finish();
  });

  const text = sink.text().replace(/\r\n?/g, '\n');
  return {
    text,
    state: rawCapped || sink.full ? BODY_STATE.truncated : BODY_STATE.indexed,
    rawTextBytes: rawUsed,
    textBytes: Buffer.byteLength(text),
    inputBytes,
    textParts,
  };
}
