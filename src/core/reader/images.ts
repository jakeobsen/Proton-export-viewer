// SPDX-License-Identifier: AGPL-3.0-or-later
// Inline images: the parts that the body's `cid:` references name, and the
// `data:` images of `<img src>`. Each passes the raster check before it is
// shown; one that doesn't, or that is over a limit, is replaced by the 1x1
// placeholder, and counted by reason.
//
// `cid:` parts are decoded on a second read of the message, once the body is
// sanitized and the parts it names are known. The second read decodes only
// those parts, within the caps, and stops after the last of them. It must find
// the same file and the same parts: if the file changed between the reads, or
// a part isn't where the first read found it, no `cid:` image is shown.
//
// Limits per message:
// - `cid:` images: at most CID_MAX_IMAGES, each at most CID_IMAGE_BYTES
//   decoded, together at most CID_TOTAL_BYTES (in message order);
// - `data:` images: each at most DATA_IMAGE_BYTES decoded, together at most
//   DATA_TOTAL_BYTES (in document order);
// - every image shown, `cid:` and `data:`, at most MESSAGE_PIXELS of frames x
//   canvas together: `data:` images first, in document order, then `cid:`
//   images by id. One `cid:` id is one part, counted once however often the
//   body refers to it; each `data:` image counts where it stands.

import { once } from 'node:events';
import type { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Splitter, type MimeNode } from '@zone-eu/mailsplit';
import { PLACEHOLDER_DATA_URL } from '../../shared/placeholder';
import type { InlineImage } from '../../shared/reader-protocol';
import { SPLITTER_OPTIONS } from './extract';
import { PartTree, type CidTarget } from './parts';
import { RASTER_REFUSALS, checkRaster } from './raster';

export const CID_MAX_IMAGES = 100;
export const CID_IMAGE_BYTES = 10 * 1024 * 1024;
export const CID_TOTAL_BYTES = 25 * 1024 * 1024;
export const DATA_IMAGE_BYTES = 1024 * 1024;
export const DATA_TOTAL_BYTES = 5 * 1024 * 1024;
export const MESSAGE_PIXELS = 400_000_000;

/** Why an inline image isn't shown. */
export const IMAGE_REFUSALS = [
  ...RASTER_REFUSALS,
  // No part in reach has the Content-ID, or the URL's escapes are invalid.
  'missing',
  // Two or more parts in reach have it.
  'ambiguous',
  // One image over its size cap.
  'too_large',
  // Over the count of `cid:` images.
  'too_many',
  // Over the bytes of all `cid:` or all `data:` images.
  'total',
  // Over the pixels of all images.
  'budget',
  // A `data:` image whose encoding is broken.
  'encoding',
  // The message changed between the reads.
  'changed',
  // The second read failed.
  'unreadable',
] as const;
export type ImageRefusal = (typeof IMAGE_REFUSALS)[number];

/** How the second read of the message is made and checked. */
export interface Reread {
  /** The message again, from its start. */
  open: () => Promise<Readable | null>;
  /** False if the file changed since the first read began. */
  unchanged?: () => Promise<boolean>;
  /** Test builds: runs between the reads. */
  between?: () => Promise<void>;
}

const DATA_IMAGE_RE = /^data:image\/(?:png|jpeg|gif|webp)(;base64)?,/i;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
// HTML's ASCII whitespace.
const SPACE_RE = /[\t\n\f\r ]/g;

/**
 * The bytes of a `data:` URL's payload: percent-escapes decoded, then base64
 * if so marked. Anything but printable ASCII, or an invalid escape or base64,
 * is an encoding error. Stops at `max` bytes.
 */
function dataBytes(payload: string, base64: boolean, max: number): Uint8Array | ImageRefusal {
  const bytes: number[] = [];
  for (let i = 0; i < payload.length; i += 1) {
    const code = payload.charCodeAt(i);
    if (code === 0x25) {
      const hex = payload.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) return 'encoding';
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else if (code > 0x20 && code < 0x7f) {
      bytes.push(code);
    } else if (
      !base64 ||
      !(code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d)
    ) {
      return 'encoding';
    }
    // Encoded base64 is a third longer than the bytes it holds.
    if (bytes.length > (base64 ? Math.ceil((max * 4) / 3) + 4 : max)) return 'too_large';
  }
  if (!base64) return new Uint8Array(bytes);
  const text = Buffer.from(bytes).toString('latin1').replace(SPACE_RE, '');
  if (!BASE64_RE.test(text) || text.length % 4 === 1) return 'encoding';
  const decoded = new Uint8Array(Buffer.from(text, 'base64'));
  return decoded.length > max ? 'too_large' : decoded;
}

/** One message's inline images, while it is rendered. */
export class InlineImages {
  private pixels = 0;
  private dataTotal = 0;
  readonly refused = new Map<ImageRefusal, number>();

  constructor(private readonly tree: PartTree) {}

  /** How many images weren't shown. */
  get refusedCount(): number {
    let count = 0;
    for (const n of this.refused.values()) count += n;
    return count;
  }

  /** The part a `cid:` reference in the HTML part `from` names. */
  resolve(from: number, url: string): CidTarget {
    return this.tree.resolve(from, url);
  }

  private refuse(reason: ImageRefusal): void {
    this.refused.set(reason, (this.refused.get(reason) ?? 0) + 1);
  }

  /** Takes an image's pixels from the message's budget, if they fit. */
  private admit(pixels: number): boolean {
    if (this.pixels + pixels > MESSAGE_PIXELS) return false;
    this.pixels += pixels;
    return true;
  }

  /**
   * The `src` an `<img>` keeps for a `data:` URL: the image, rewritten with
   * the type found and plain base64, or the placeholder; or null when it
   * isn't a `data:` image at all, and goes.
   */
  dataImage(value: string): string | null {
    const url = value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');
    const match = DATA_IMAGE_RE.exec(url);
    if (!match) return null;
    const bytes = dataBytes(url.slice(match[0].length), match[1] !== undefined, DATA_IMAGE_BYTES);
    const refused = (reason: ImageRefusal) => {
      this.refuse(reason);
      return PLACEHOLDER_DATA_URL;
    };
    if (typeof bytes === 'string') return refused(bytes);
    if (this.dataTotal + bytes.length > DATA_TOTAL_BYTES) return refused('total');
    const check = checkRaster(bytes);
    if (!check.ok) return refused(check.reason);
    if (!this.admit(check.image.pixels)) return refused('budget');
    this.dataTotal += bytes.length;
    return `data:${check.image.contentType};base64,${Buffer.from(bytes).toString('base64')}`;
  }

  /**
   * The images to serve for the body's `cid:` ids, `targets[n - 1]` being
   * what `c<n>` names. Ids not served get the placeholder.
   */
  async load(targets: readonly CidTarget[], reread: Reread | null): Promise<InlineImage[]> {
    const wanted = new Map<number, string>();
    for (const [i, target] of targets.entries()) {
      if ('refused' in target) this.refuse(target.refused);
      else if (wanted.size >= CID_MAX_IMAGES) this.refuse('too_many');
      else wanted.set(target.part, `c${i + 1}`);
    }
    if (wanted.size === 0) return [];
    const found = await this.readParts(new Set(wanted.keys()), reread);
    const images: InlineImage[] = [];
    for (const [part, id] of wanted) {
      const bytes = found.get(part) ?? 'unreadable';
      if (typeof bytes === 'string') {
        this.refuse(bytes);
        continue;
      }
      const check = checkRaster(bytes);
      if (!check.ok) this.refuse(check.reason);
      else if (!this.admit(check.image.pixels)) this.refuse('budget');
      else images.push({ id, contentType: check.image.contentType, bytes });
    }
    return images;
  }

  /** The second read: the wanted parts' decoded bytes, or why each has none. */
  private async readParts(
    wanted: ReadonlySet<number>,
    reread: Reread | null,
  ): Promise<Map<number, Uint8Array | ImageRefusal>> {
    const all = (reason: ImageRefusal) => new Map([...wanted].map((part) => [part, reason]));
    if (!reread) return all('unreadable');
    await reread.between?.();
    const input = await reread.open().catch(() => null);
    if (!input) return all('unreadable');
    const found = await decodeParts(input, this.tree, wanted).catch(() => null);
    if (!found) return all('unreadable');
    if (reread.unchanged && !(await reread.unchanged().catch(() => false))) return all('changed');
    return found;
  }
}

type SplitChunk = MimeNode | { type: 'data' | 'body' | 'none'; value?: Buffer };

interface Decoding {
  part: number;
  decoder: Transform;
  chunks: Buffer[];
  size: number;
  over: ImageRefusal | null;
}

/**
 * Splits the message again and decodes the wanted parts, each within
 * CID_IMAGE_BYTES and all within CID_TOTAL_BYTES. Each is found by its path,
 * and must be as the first read found it (`tree`): still a leaf, with the
 * same Content-ID. Stops once the last wanted part is read.
 */
async function decodeParts(
  input: Readable,
  tree: PartTree,
  wanted: ReadonlySet<number>,
): Promise<Map<number, Uint8Array | ImageRefusal>> {
  const out = new Map<number, Uint8Array | ImageRefusal>();
  const again = new PartTree();
  // The wanted parts by path, as the first read numbered them.
  const byPath = new Map<string, number>();
  for (const part of wanted) {
    const record = tree.parts[part];
    if (record) byPath.set(record.path, part);
  }
  const state: { current: Decoding | null; total: number; done: boolean } = {
    current: null,
    total: 0,
    done: false,
  };

  const settle = (part: number, value: Uint8Array | ImageRefusal) => {
    out.set(part, value);
    if (out.size === wanted.size) state.done = true;
  };

  const finish = async () => {
    const part = state.current;
    state.current = null;
    if (!part) return;
    const ended = once(part.decoder, 'end');
    part.decoder.end();
    await ended;
    if (part.over) {
      settle(part.part, part.over);
    } else {
      state.total += part.size;
      settle(part.part, new Uint8Array(Buffer.concat(part.chunks)));
    }
  };

  const start = (node: MimeNode, part: number): Decoding => {
    const decoding: Decoding = {
      part,
      decoder: node.getDecoder() as Transform,
      chunks: [],
      size: 0,
      over: null,
    };
    decoding.decoder.on('data', (chunk: Buffer) => {
      if (decoding.over) return;
      decoding.size += chunk.length;
      if (decoding.size > CID_IMAGE_BYTES) decoding.over = 'too_large';
      else if (state.total + decoding.size > CID_TOTAL_BYTES) decoding.over = 'total';
      if (decoding.over) decoding.chunks = [];
      else decoding.chunks.push(chunk);
    });
    return decoding;
  };

  /** Whether the part now at a wanted part's path is the one the first read found there. */
  const same = (part: number, now: number): boolean => {
    const first = tree.parts[part];
    const found = again.parts[now];
    return (
      first !== undefined &&
      found !== undefined &&
      found.multipart === null &&
      found.contentId === first.contentId
    );
  };

  const consume = async (source: AsyncIterable<SplitChunk>) => {
    for await (const chunk of source) {
      if (chunk.type === 'node') {
        await finish();
        if (state.done) return;
        const node = chunk as MimeNode;
        const now = again.add(node);
        const part = byPath.get(again.parts[now]?.path ?? '');
        if (part === undefined) continue;
        if (same(part, now)) state.current = start(node, part);
        else settle(part, 'changed');
        continue;
      }
      if (chunk.type === 'data') {
        // A boundary: the part before it has ended.
        await finish();
        if (state.done) return;
        continue;
      }
      const decoding = state.current;
      if (chunk.type !== 'body' || !decoding || decoding.over || !('value' in chunk)) continue;
      if (chunk.value && !decoding.decoder.write(chunk.value)) {
        await once(decoding.decoder, 'drain');
      }
    }
    await finish();
  };

  try {
    await pipeline(input, new Splitter(SPLITTER_OPTIONS), consume);
  } catch (err) {
    // Leaving the read early, once every wanted part is in, aborts it.
    if (!state.done) throw err;
  }
  for (const part of wanted) if (!out.has(part)) out.set(part, 'changed');
  return out;
}
