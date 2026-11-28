// SPDX-License-Identifier: AGPL-3.0-or-later
// What the source view reads from a message, in the reader worker: the
// message's raw header block, its structure, and the raw header block of one
// part. The message's own header block is read without a parse, by bytes up
// to the first empty line, so it can be shown even for a message the reader
// couldn't render. The structure and a part's headers come from a parse with
// the reader's own splitter options and part numbering, so a path means the
// same part to the reader, the attachment list and the source view.

import { once } from 'node:events';
import type { Readable, Transform } from 'node:stream';
import { Splitter, type MimeNode } from '@zone-eu/mailsplit';
import { cleanFilename } from '../../shared/filename';
import { SOURCE_HEADER_BYTES, type SourcePart } from '../../shared/reader-protocol';
import { SPLITTER_OPTIONS, splitWithinLimits } from './extract';
import { PartTree } from './parts';

export { SOURCE_HEADER_BYTES };

export interface HeaderBlock {
  /** The block's raw bytes, at most SOURCE_HEADER_BYTES. */
  bytes: Buffer;
  /** More of the block was there than `bytes` holds. */
  truncated: boolean;
}

/**
 * The message's header block: its bytes up to the first empty line (a line
 * that is empty or holds only CR), without parsing anything. At most `cap`
 * bytes; `truncated` when the block goes on past them.
 */
export async function messageHeaderBlock(
  input: Readable,
  cap: number = SOURCE_HEADER_BYTES,
): Promise<HeaderBlock> {
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      chunks.push(bytes);
      length += bytes.length;
      const read = Buffer.concat(chunks, length);
      const end = blockEnd(read);
      if (end >= 0) return block(read.subarray(0, end), cap);
      // Past the cap with no end in sight: the block is cut there. One more
      // byte than the cap is enough to know it goes on.
      if (length > cap + 2) return { bytes: Buffer.from(read.subarray(0, cap)), truncated: true };
    }
  } finally {
    input.destroy();
  }
  // The message ends inside its header block: all of it is the block.
  return block(Buffer.concat(chunks, length), cap);
}

/** Where the header block in `bytes` ends: before its first empty line, or -1. */
function blockEnd(bytes: Buffer): number {
  // A message that starts with an empty line has no header block.
  if (bytes[0] === 0x0a) return 0;
  if (bytes[0] === 0x0d && bytes[1] === 0x0a) return 0;
  for (
    let i = bytes.indexOf(0x0a);
    i >= 0 && i + 1 < bytes.length;
    i = bytes.indexOf(0x0a, i + 1)
  ) {
    const next = bytes[i + 1];
    if (next === 0x0a) return i + 1;
    if (next === 0x0d && bytes[i + 2] === 0x0a) return i + 1;
    if (next === 0x0d && i + 2 >= bytes.length) return -1;
  }
  return -1;
}

function block(bytes: Buffer, cap: number): HeaderBlock {
  return bytes.length > cap
    ? { bytes: Buffer.from(bytes.subarray(0, cap)), truncated: true }
    : { bytes: Buffer.from(bytes), truncated: false };
}

interface Counting {
  decoder: Transform;
}

/**
 * The message's parts, in the reader's numbering, each leaf with its decoded
 * size. Bodies only pass through their transfer decoders to be counted; none
 * is kept. A container's size is the sum of its parts', once all are read.
 * Past the reader's part limits the read stops as the reader's does: the
 * parts before the stop are listed, and the containers still open there are
 * cut.
 */
export async function messageStructure(input: Readable): Promise<SourcePart[]> {
  const splitter = new Splitter(SPLITTER_OPTIONS);
  const tree = new PartTree();
  const parts: SourcePart[] = [];
  const containers = new Set<number>();
  let counting: Counting | null = null;

  const finishCount = async () => {
    const c = counting;
    counting = null;
    if (!c) return;
    const ended = once(c.decoder, 'end');
    c.decoder.end();
    await ended;
  };

  const stopped = await splitWithinLimits(input, splitter, async (source) => {
    for await (const chunk of source) {
      if (chunk.type === 'node') {
        await finishCount();
        const node = chunk as MimeNode;
        const index = tree.add(node);
        const record = tree.parts[index]!;
        const part: SourcePart = {
          path: record.path,
          parent: record.parent,
          contentType: record.contentType,
          charset: typeof node.charset === 'string' && node.charset !== '' ? node.charset : null,
          name: record.filename === null ? '' : cleanFilename(record.filename),
          inline: record.disposition === 'inline',
          size: 0,
          cut: false,
        };
        parts.push(part);
        if (record.multipart !== null) {
          containers.add(index);
        } else {
          const decoder = node.getDecoder() as Transform;
          decoder.on('data', (bytes: Buffer) => {
            part.size += bytes.length;
          });
          counting = { decoder };
        }
        continue;
      }
      if (chunk.type !== 'body' || !('value' in chunk) || !chunk.value) continue;
      const c = counting as Counting | null;
      if (c && !c.decoder.write(chunk.value)) await once(c.decoder, 'drain');
    }
    await finishCount();
  });
  if (stopped) {
    // The limit is met in a part's header block, after the leaf before it
    // ended. The containers still open there are the last part read, if it is
    // a container, and every part above it.
    await finishCount();
    for (let i = parts.length - 1; parts[i]; i = parts[i]!.parent) {
      if (containers.has(i)) parts[i]!.cut = true;
    }
  }

  // Containers add up their parts, deepest first: a part's index is always
  // after its parent's.
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i]!;
    const parent = parts[part.parent];
    if (!parent) continue;
    parent.size += part.size;
  }
  return parts;
}

/**
 * The raw header block of the part with this path, as the splitter read it,
 * at most `cap` bytes. The read stops once that part has been seen. Null if
 * the message has no such part before the reader's part limits.
 */
export async function partHeaderBlock(
  input: Readable,
  path: string,
  cap: number = SOURCE_HEADER_BYTES,
): Promise<HeaderBlock | null> {
  const splitter = new Splitter(SPLITTER_OPTIONS);
  const tree = new PartTree();
  let found: HeaderBlock | null = null;
  const done = new Error('found');
  try {
    await splitWithinLimits(input, splitter, async (source) => {
      for await (const chunk of source) {
        if (chunk.type !== 'node') continue;
        const node = chunk as MimeNode;
        const record = tree.parts[tree.add(node)]!;
        if (record.path !== path) continue;
        found = block(node.getHeaders(), cap);
        throw done;
      }
    });
  } catch (err) {
    if (err !== done) throw err;
  }
  return found;
}
