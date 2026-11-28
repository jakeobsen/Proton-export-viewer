// SPDX-License-Identifier: AGPL-3.0-or-later
// Reads a message for the reader in one pass, with bounded memory: the header
// fields, and the text and HTML bodies. Body parts are chosen and decoded the
// way mailparser does it (transfer encoding, format=flowed, then the charset
// with the same refusals). Of each body kind, at most KEEP_BYTES of encoded
// content is kept; the rest of it, and every other part, is read and dropped
// without being decoded. Every part is recorded in a PartTree, so that inline
// images can be found by what the HTML body refers to. Each part the index
// lists as an attachment is decoded as it streams by, kept only as its decoded
// size and first bytes, for the reader's attachment list. A part that may be
// an image to preview (an image signature, at most PREVIEW_MAX_BYTES decoded)
// is also kept whole until it ends, when the raster check runs on it and its
// bytes are let go: one such part is held at a time, and at most
// PREVIEW_CHECK_BYTES of them are checked per read. A message past the
// parser's limits (more than MAX_MIME_PARTS parts, or a header block over
// MAX_HEAD_BYTES) is read up to there; any other read error fails the read.

import { once } from 'node:events';
import { Readable, Writable, type Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Splitter, type MimeNode } from '@zone-eu/mailsplit';
import FlowedDecoder from '@zone-eu/mailsplit/lib/flowed-decoder.js';
import libmime from 'libmime';
import { MailParser, type HeaderLines, type Headers } from 'mailparser';
import { isAttachment } from '../index/body';
import {
  PREVIEW_CHECK_BYTES,
  PREVIEW_MAX_BYTES,
  type AttachmentPreview,
} from '../../shared/reader-protocol';
import { MAX_HEAD_BYTES, MAX_MIME_PARTS } from '../mime-limits';
import { PartTree } from './parts';
import { checkRaster, rasterFormat } from './raster';

/** Encoded bytes kept of each body kind (text, HTML); the rest is dropped. */
export const KEEP_BYTES = 20 * 1024 * 1024;

/** How the reader splits a message, on every read of it. */
export const SPLITTER_OPTIONS = {
  maxHeadSize: MAX_HEAD_BYTES,
  maxChildNodes: MAX_MIME_PARTS,
  ignoreEmbedded: true,
} as const;

/** Content types read as text bodies, as mailparser reads them. */
const TEXT_TYPES = new Set(['text/plain', 'text/html', 'message/delivery-status']);
/** Charsets that need no decoding, compared without case or punctuation. */
const PLAIN_CHARSETS = new Set(['ascii', 'usascii', 'utf8']);

/** The body parts of one kind. */
export interface Body {
  /** The decoded parts, joined as mailparser joins them. Cut if `cut` is set. */
  content: string;
  /** Encoded bytes of all parts of this kind, including any dropped. */
  bytes: number;
  /** True if more than KEEP_BYTES was found, so `content` holds only the first part of it. */
  cut: boolean;
}

/** Where one HTML part is in the joined HTML body. */
export interface HtmlPart {
  /** Its index in the part tree. */
  part: number;
  /** Its first character in `html.content`. */
  start: number;
  /** The character after its last. */
  end: number;
}

/** How many decoded bytes of an attachment are kept, to tell its format by its signature. */
export const HEAD_BYTES = 16;

/** A part the index lists as an attachment, as the reader read it. */
export interface ListedPart {
  /** Its index in the part tree. */
  part: number;
  /** Its decoded size, in bytes, as its transfer decoder gives it. */
  size: number;
  /** Its first decoded bytes, at most HEAD_BYTES. */
  head: Buffer;
  /** Its format and canvas if the whole part passed the raster check; else null. */
  preview: AttachmentPreview | null;
}

export interface ExtractedMessage {
  headers: Headers | null;
  lines: HeaderLines | null;
  text: Body;
  html: Body;
  /** Every part of the message, as the splitter found it. */
  tree: PartTree;
  /** The HTML parts that make up `html.content`, in order. */
  htmlParts: HtmlPart[];
  /** The parser stopped at one of its limits: the bodies hold what came before. */
  stopped: boolean;
  /** The parts the index lists as attachments, in message order. */
  listed: ListedPart[];
  /** Preview candidates left unchecked because the read's check budget was spent. */
  previewUnchecked: number;
  /** The most decoded bytes held at once for a preview check. */
  previewHeldPeak: number;
}

interface Counting {
  part: number;
  decoder: Transform;
  size: number;
  head: Buffer[];
  headBytes: number;
  /** Whether its first bytes have an image signature; null until HEAD_BYTES are in. */
  signed: boolean | null;
  /** The decoded part, while it may still be previewed; null once it can't be. */
  kept: Buffer[] | null;
  /** The check budget ran out while it was kept. */
  overBudget: boolean;
}

/** Whether a part with these first bytes and this decoded size may be previewed. */
export function previewCandidate(head: Uint8Array, size: number): boolean {
  return size <= PREVIEW_MAX_BYTES && rasterFormat(head) !== null;
}

type Kind = 'text' | 'html';

/** What joins HTML parts into one body, as mailparser joins them. */
const HTML_SEPARATOR = '<br/>\n';

interface Collected {
  parts: Array<{ content: string; part: number }>;
  bytes: number;
  kept: number;
  cut: boolean;
}

interface ActivePart {
  node: MimeNode;
  /** Its index in the part tree. */
  part: number;
  kind: Kind;
  chunks: Buffer[];
}

export type SplitChunk = MimeNode | { type: 'data' | 'body' | 'none'; value?: Buffer };

/**
 * Runs `consume` over the chunks `splitter` makes of `input`. Resolves true
 * when the splitter stopped at one of its limits (more than MAX_MIME_PARTS
 * parts, or a header block over MAX_HEAD_BYTES): `consume` saw what came
 * before, and its own end-of-message steps did not run. Resolves false at
 * the message's end. Any other error rejects.
 */
export async function splitWithinLimits(
  input: Readable,
  splitter: Splitter,
  consume: (source: AsyncIterable<SplitChunk>) => Promise<void>,
): Promise<boolean> {
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
  try {
    await pipeline(input, splitter, async (source: AsyncIterable<SplitChunk>) => {
      try {
        await consume(source);
      } catch (err) {
        noteElsewhere(err);
        throw err;
      }
    });
    return false;
  } catch (err) {
    if (splitterLimit === null || err !== splitterLimit) throw err;
    return true;
  }
}

/** Which body a leaf part belongs to, or null if it is not a body part (mailparser's rules). */
export function bodyKind(node: MimeNode): Kind | null {
  if (node.multipart) return null;
  const contentType = node.contentType || (node.root ? 'text/plain' : '');
  if (!TEXT_TYPES.has(contentType)) return null;
  // Any disposition other than inline (none counts as inline) makes it an attachment.
  if (node.disposition && node.disposition !== 'inline') return null;
  return contentType === 'text/html' ? 'html' : 'text';
}

/** Decodes the kept bytes of one part: transfer encoding, format=flowed, then the charset. */
async function decodePart(node: MimeNode, chunks: Buffer[]): Promise<string> {
  const stages: NodeJS.ReadWriteStream[] = [node.getDecoder()];
  if (node.flowed) stages.push(new FlowedDecoder({ delSp: node.delSp }));
  const charset = typeof node.charset === 'string' ? node.charset : 'utf-8';
  if (!PLAIN_CHARSETS.has(charset.toLowerCase().replace(/[^a-z0-9]+/g, ''))) {
    try {
      stages.push(libmime.createDecodeStream(charset) as unknown as NodeJS.ReadWriteStream);
    } catch {
      // Left undecoded, as mailparser leaves it.
    }
  }
  const out: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer | string, _encoding, done) {
      out.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      done();
    },
  });
  await pipeline([Readable.from(chunks), ...stages, sink]);
  return Buffer.concat(out).toString().replace(/\r?\n/g, '\n');
}

/** The header fields of the root header block, parsed by mailparser. */
function parseHeaders(
  block: Buffer,
): Promise<{ headers: Headers | null; lines: HeaderLines | null }> {
  const parser = new MailParser({
    skipHtmlToText: true,
    skipTextToHtml: true,
    skipTextLinks: true,
    skipImageLinks: true,
    checksumAlgo: false,
  });
  const found: { headers: Headers | null; lines: HeaderLines | null } = {
    headers: null,
    lines: null,
  };
  return new Promise((resolve, reject) => {
    parser.on('headers', (headers: Headers) => {
      found.headers = headers;
    });
    parser.on('headerLines', (lines: HeaderLines) => {
      found.lines = lines;
    });
    // The block is headers only; whatever body data mailparser gives is empty.
    parser.on('data', (data) => {
      if (data.type === 'attachment') data.release?.();
    });
    parser.once('end', () => resolve(found));
    parser.once('error', reject);
    parser.end(block);
  });
}

function joined(collected: Collected, separator: string): Body {
  return {
    content: collected.parts.map((p) => p.content).join(separator),
    bytes: collected.bytes,
    cut: collected.cut,
  };
}

/** Where each part is in what `joined` makes of them. */
function offsets(collected: Collected, separator: string): HtmlPart[] {
  const out: HtmlPart[] = [];
  let at = 0;
  for (const { content, part } of collected.parts) {
    out.push({ part, start: at, end: at + content.length });
    at += content.length + separator.length;
  }
  return out;
}

/** Reads a message: its header fields, and its text and HTML bodies within KEEP_BYTES each. */
export async function extractMessage(
  input: Readable,
  keepBytes = KEEP_BYTES,
  checkBytes = PREVIEW_CHECK_BYTES,
): Promise<ExtractedMessage> {
  const splitter = new Splitter(SPLITTER_OPTIONS);
  const tree = new PartTree();
  const collected: Record<Kind, Collected> = {
    text: { parts: [], bytes: 0, kept: 0, cut: false },
    html: { parts: [], bytes: 0, kept: 0, cut: false },
  };
  let headerBlock: Buffer | null = null;
  let active: ActivePart | null = null;

  const finish = async () => {
    const part = active;
    active = null;
    if (!part || part.chunks.length === 0) return;
    const content = await decodePart(part.node, part.chunks);
    collected[part.kind].parts.push({ content, part: part.part });
  };

  // The attachment being decoded, by the same transfer decoder a save of it
  // streams through, so the size listed is the size saved.
  const listed: ListedPart[] = [];
  let counting: Counting | null = null;
  // Decoded bytes of preview candidates checked so far in this read.
  let checked = 0;
  let previewUnchecked = 0;
  let previewHeldPeak = 0;
  const count = (node: MimeNode, part: number) => {
    const decoder = node.getDecoder() as Transform;
    const c: Counting = {
      part,
      decoder,
      size: 0,
      head: [],
      headBytes: 0,
      signed: null,
      kept: [],
      overBudget: false,
    };
    decoder.on('data', (bytes: Buffer) => {
      c.size += bytes.length;
      if (c.headBytes < HEAD_BYTES) {
        const take = Buffer.from(bytes.subarray(0, HEAD_BYTES - c.headBytes));
        c.head.push(take);
        c.headBytes += take.length;
        if (c.headBytes >= HEAD_BYTES) c.signed = rasterFormat(Buffer.concat(c.head)) !== null;
      }
      if (!c.kept) return;
      if (c.size > PREVIEW_MAX_BYTES || c.signed === false) {
        c.kept = null;
        return;
      }
      if (checked + c.size > checkBytes) {
        c.kept = null;
        c.overBudget = true;
        return;
      }
      c.kept.push(bytes);
      previewHeldPeak = Math.max(previewHeldPeak, c.size);
    });
    counting = c;
  };
  const finishCount = async () => {
    const c = counting;
    counting = null;
    if (!c) return;
    const ended = once(c.decoder, 'end');
    c.decoder.end();
    await ended;
    const head = Buffer.concat(c.head);
    let preview: AttachmentPreview | null = null;
    if (c.kept && previewCandidate(head, c.size)) {
      const result = checkRaster(Buffer.concat(c.kept, c.size));
      checked += c.size;
      if (result.ok) {
        const { format, width, height } = result.image;
        preview = { format, width, height };
      }
    } else if (c.overBudget && previewCandidate(head, c.size)) {
      previewUnchecked += 1;
    }
    c.kept = null;
    listed.push({ part: c.part, size: c.size, head, preview });
  };

  async function consume(source: AsyncIterable<SplitChunk>): Promise<void> {
    for await (const chunk of source) {
      if (chunk.type === 'node') {
        await finish();
        await finishCount();
        const node = chunk as MimeNode;
        const part = tree.add(node);
        if (node.root) headerBlock = node.getHeaders();
        const kind = bodyKind(node);
        if (kind) active = { node, part, kind, chunks: [] };
        if (isAttachment(node)) count(node, part);
        continue;
      }
      if (chunk.type !== 'body' || !('value' in chunk) || !chunk.value) continue;
      const decoding = counting as Counting | null;
      if (decoding && !decoding.decoder.write(chunk.value)) await once(decoding.decoder, 'drain');
      if (!active) continue;
      const into = collected[active.kind];
      const value = chunk.value;
      into.bytes += value.length;
      const room = keepBytes - into.kept;
      if (value.length <= room) {
        active.chunks.push(value);
        into.kept += value.length;
        continue;
      }
      // Past the limit: keep what fits, drop the rest without decoding it.
      if (room > 0) active.chunks.push(Buffer.from(value.subarray(0, room)));
      into.kept += Math.max(room, 0);
      into.cut = true;
    }
    await finish();
    await finishCount();
  }

  const stopped = await splitWithinLimits(input, splitter, consume);
  if (stopped) {
    // The limit is met in a part's header block, after the parts before it
    // ended: they are kept, and listed.
    await finish();
    await finishCount();
  }

  const { headers, lines } = headerBlock
    ? await parseHeaders(headerBlock)
    : { headers: null, lines: null };
  return {
    headers,
    lines,
    text: joined(collected.text, '\n'),
    html: joined(collected.html, HTML_SEPARATOR),
    tree,
    htmlParts: offsets(collected.html, HTML_SEPARATOR),
    stopped,
    listed,
    previewUnchecked,
    previewHeldPeak,
  };
}
