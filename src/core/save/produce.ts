// SPDX-License-Identifier: AGPL-3.0-or-later
// The bytes of one save, in chunks: a part's decoded bytes, found by its path
// with the reader's own numbering, or the message file as it is. A preview is
// a part whose completing bytes also wait for the raster check.
//
// A save streams exactly the size the view listed. One byte more, or an end
// before it, means the message isn't the one the view showed, and the save
// fails. The bytes that would complete the save are held back until the input
// has ended and the count is right, so whoever receives the chunks never has
// the whole file before that check.

import { once } from 'node:events';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Splitter, type MimeNode } from '@zone-eu/mailsplit';
import { SAVE_CHUNK_BYTES, type SaveTarget } from '../../shared/save-protocol';
import { SPLITTER_OPTIONS } from '../reader/extract';
import { PartTree } from '../reader/parts';
import { checkRaster } from '../reader/raster';

/** Bytes of input read between two ticks while no chunk is ready. */
export const TICK_BYTES = 8 * 1024 * 1024;

/** Where the chunks go. */
export interface ChunkSink {
  /** Takes one chunk; resolves once the next one may be made. */
  put(bytes: Uint8Array): Promise<void>;
  /** Says the save is still reading. */
  tick(): void;
}

/** The save can't go on: the message changed, or it couldn't be read. */
export class SaveStop extends Error {
  constructor(readonly reason: 'changed' | 'unreadable' | 'refused') {
    super(reason);
    this.name = 'SaveStop';
  }
}

/**
 * Cuts bytes into chunks of SAVE_CHUNK_BYTES and sends them on, never the
 * byte that reaches `expected`: those stay until `finish`.
 */
export class Chunker {
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private sent = 0;

  constructor(
    private readonly expected: number,
    private readonly sink: ChunkSink,
    private readonly chunkBytes = SAVE_CHUNK_BYTES,
  ) {}

  /** Adds bytes; sends every chunk that is full and doesn't complete the save. */
  async push(bytes: Buffer): Promise<void> {
    if (bytes.length === 0) return;
    if (this.sent + this.pendingBytes + bytes.length > this.expected) {
      throw new SaveStop('changed');
    }
    this.pending.push(bytes);
    this.pendingBytes += bytes.length;
    while (this.pendingBytes >= this.chunkBytes && this.sent + this.chunkBytes < this.expected) {
      const all = Buffer.concat(this.pending, this.pendingBytes);
      const chunk = all.subarray(0, this.chunkBytes);
      const rest = all.subarray(this.chunkBytes);
      this.pending = rest.length > 0 ? [Buffer.from(rest)] : [];
      this.pendingBytes = rest.length;
      this.sent += chunk.length;
      await this.sink.put(new Uint8Array(chunk));
    }
  }

  /** The held bytes, once the input has ended: exactly what completes the save. */
  finish(): Uint8Array {
    if (this.sent + this.pendingBytes !== this.expected) throw new SaveStop('changed');
    const last = Buffer.concat(this.pending, this.pendingBytes);
    this.pending = [];
    this.pendingBytes = 0;
    return new Uint8Array(last);
  }
}

/** Counts input bytes, and ticks every TICK_BYTES so a long walk to a part counts as progress. */
function ticker(sink: ChunkSink): Transform {
  let since = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      since += chunk.length;
      if (since >= TICK_BYTES) {
        since = 0;
        sink.tick();
      }
      callback(null, chunk);
    },
  });
}

/** The message file as it is, `target.size` bytes from its start. */
export async function produceFile(
  input: Readable | null,
  target: Extract<SaveTarget, { kind: 'eml' }>,
  sink: ChunkSink,
): Promise<Uint8Array> {
  const chunker = new Chunker(target.size, sink);
  if (input) {
    try {
      for await (const chunk of input) await chunker.push(chunk as Buffer);
    } catch (err) {
      if (err instanceof SaveStop) throw err;
      throw new SaveStop('unreadable');
    }
  }
  return chunker.finish();
}

type SplitChunk = MimeNode | { type: 'data' | 'body' | 'none'; value?: Buffer };

/** Ends a split early, once the part has been read. */
class Done extends Error {}

/**
 * One part's decoded bytes. The message is split as the reader splits it, and
 * the part at `target.path` must be a leaf with the listed type.
 */
export async function producePart(
  input: Readable,
  target: Extract<SaveTarget, { kind: 'part' | 'preview' }>,
  sink: ChunkSink,
): Promise<Uint8Array> {
  const tree = new PartTree();
  const chunker = new Chunker(target.size, sink);
  let decoder: Transform | null = null;
  let feeding: Promise<void> = Promise.resolve();
  let failure: unknown = null;
  let last: Uint8Array | null = null;

  /** Ends the part's decoding and takes the held bytes. */
  const finishPart = async (): Promise<void> => {
    const current = decoder;
    if (!current) return;
    decoder = null;
    const ended = once(current, 'end');
    current.end();
    await ended;
    await feeding;
    if (failure) throw failure;
    last = chunker.finish();
    throw new Done();
  };

  const startPart = (node: MimeNode): void => {
    const current = node.getDecoder() as Transform;
    decoder = current;
    current.on('error', (err: unknown) => {
      failure ??= err;
    });
    current.on('data', (chunk: Buffer) => {
      // The chunker's sink waits while the receiver is behind: the decoder is
      // paused meanwhile, which in turn holds the split and the file read.
      current.pause();
      feeding = feeding
        .then(() => chunker.push(chunk))
        .catch((err: unknown) => {
          failure ??= err;
        })
        .finally(() => {
          if (failure) current.destroy(failure as Error);
          else current.resume();
        });
    });
  };

  const consume = async (source: AsyncIterable<SplitChunk>) => {
    for await (const chunk of source) {
      if (chunk.type === 'node') {
        await finishPart();
        const node = chunk as MimeNode;
        const record = tree.parts[tree.add(node)];
        if (record?.path !== target.path) continue;
        if (record.multipart !== null || record.contentType !== target.contentType) {
          throw new SaveStop('changed');
        }
        startPart(node);
        continue;
      }
      if (chunk.type === 'data') {
        // A boundary: the part before it has ended.
        await finishPart();
        continue;
      }
      const current = decoder;
      if (chunk.type !== 'body' || !current || !chunk.value) continue;
      if (failure) throw failure;
      if (!current.write(chunk.value)) await once(current, 'drain');
    }
    await finishPart();
  };

  try {
    await pipeline(input, ticker(sink), new Splitter(SPLITTER_OPTIONS), consume);
  } catch (err) {
    if (!(err instanceof Done)) {
      if (err instanceof SaveStop) throw err;
      if (failure instanceof SaveStop) throw failure;
      throw new SaveStop('unreadable');
    }
  }
  // The input ended without the part: it isn't where the view found it.
  if (last === null) throw new SaveStop('changed');
  return last;
}

/** Passes each chunk on, keeping a copy first: the original goes to core with its message. */
function keeping(sink: ChunkSink, kept: Uint8Array[]): ChunkSink {
  return {
    put: (bytes) => {
      kept.push(Uint8Array.from(bytes));
      return sink.put(bytes);
    },
    tick: () => sink.tick(),
  };
}

/**
 * One image part's decoded bytes, for a preview: as producePart, but the
 * bytes that complete it come back only if the whole part passes the raster
 * check as the format listed. Otherwise it fails as refused. The part is at
 * most the preview cap, which the lane checks before it starts.
 */
export async function producePreview(
  input: Readable,
  target: Extract<SaveTarget, { kind: 'preview' }>,
  sink: ChunkSink,
): Promise<Uint8Array> {
  const kept: Uint8Array[] = [];
  const last = await producePart(input, target, keeping(sink, kept));
  const checked = checkRaster(Buffer.concat([...kept, last]));
  if (!checked.ok || checked.image.format !== target.format) throw new SaveStop('refused');
  return last;
}
