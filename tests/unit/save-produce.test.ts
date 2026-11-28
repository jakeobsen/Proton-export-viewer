// SPDX-License-Identifier: AGPL-3.0-or-later
// A save's bytes: a part found by the reader's numbering and decoded, or the
// message file as it is; exactly the listed size, with the completing bytes
// held back until the input has ended.

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  Chunker,
  SaveStop,
  produceFile,
  producePart,
  type ChunkSink,
} from '../../src/core/save/produce';
import { SAVE_CHUNK_BYTES } from '../../src/shared/save-protocol';

/** A sink that records each chunk, and the order of puts. */
function recorder(): ChunkSink & { chunks: Uint8Array[]; ticks: number } {
  const sink = {
    chunks: [] as Uint8Array[],
    ticks: 0,
    put: (bytes: Uint8Array) => {
      sink.chunks.push(bytes);
      return Promise.resolve();
    },
    tick: () => {
      sink.ticks += 1;
    },
  };
  return sink;
}

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const joined = (chunks: Uint8Array[], last: Uint8Array) => Buffer.concat([...chunks, last]);

/** Deterministic bytes. */
function bytesOf(n: number, seed = 7): Buffer {
  const out = Buffer.alloc(n);
  let x = seed;
  for (let i = 0; i < n; i += 1) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x & 0xff;
  }
  return out;
}

/** base64 in 76-character lines, as mail has it. */
function base64Lines(bytes: Buffer): string {
  return (bytes.toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');
}

/**
 * multipart/mixed: a text part (1.1), a nested multipart/alternative (1.2)
 * holding a text part (1.2.1), then an attachment (1.3) and a second one (1.4).
 */
function message(att: Buffer, second: Buffer = Buffer.from('second file')): Buffer {
  const lines = [
    'From: a@example.test',
    'To: b@example.test',
    'Subject: save test',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="outer"',
    '',
    '--outer',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Body text.',
    '--outer',
    'Content-Type: multipart/alternative; boundary="inner"',
    '',
    '--inner',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Alternative.',
    '--inner--',
    '--outer',
    'Content-Type: application/pdf; name="file.pdf"',
    'Content-Disposition: attachment; filename="file.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(att),
    '--outer',
    'Content-Type: application/octet-stream',
    'Content-Disposition: attachment; filename="two.bin"',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    second.toString('latin1'),
    '--outer--',
    '',
  ];
  return Buffer.from(lines.join('\r\n'), 'latin1');
}

const input = (bytes: Buffer, chunk = 4096) => {
  const pieces: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += chunk) pieces.push(bytes.subarray(i, i + chunk));
  return Readable.from(pieces);
};

describe('Chunker', () => {
  it('sends full chunks and holds the bytes that complete the save until finish', async () => {
    const sink = recorder();
    const total = SAVE_CHUNK_BYTES * 2;
    const chunker = new Chunker(total, sink);
    await chunker.push(bytesOf(total));
    // Exactly two chunks' worth: the second would complete it, so it is held.
    expect(sink.chunks.map((c) => c.length)).toEqual([SAVE_CHUNK_BYTES]);
    const last = chunker.finish();
    expect(last.length).toBe(SAVE_CHUNK_BYTES);
    expect(sha(joined(sink.chunks, last))).toBe(sha(bytesOf(total)));
  });

  it('never sends a chunk that reaches the expected size, however the bytes come', async () => {
    const sink = recorder();
    const total = SAVE_CHUNK_BYTES * 3 + 17;
    const chunker = new Chunker(total, sink);
    const all = bytesOf(total);
    for (let i = 0; i < total; i += 100_003) await chunker.push(all.subarray(i, i + 100_003));
    const sent = sink.chunks.reduce((n, c) => n + c.length, 0);
    expect(sent).toBeLessThan(total);
    expect(sink.chunks.every((c) => c.length === SAVE_CHUNK_BYTES)).toBe(true);
    const last = chunker.finish();
    expect(last.length).toBeLessThanOrEqual(SAVE_CHUNK_BYTES);
    expect(sha(joined(sink.chunks, last))).toBe(sha(all));
  });

  it('fails as changed on one byte past the expected size', async () => {
    const chunker = new Chunker(10, recorder());
    await chunker.push(Buffer.alloc(10));
    await expect(chunker.push(Buffer.alloc(1))).rejects.toEqual(new SaveStop('changed'));
  });

  it('fails as changed when the input ends short', async () => {
    const chunker = new Chunker(10, recorder());
    await chunker.push(Buffer.alloc(9));
    expect(() => chunker.finish()).toThrow(SaveStop);
  });

  it('waits for the sink before the next chunk', async () => {
    let release!: () => void;
    const order: string[] = [];
    const sink: ChunkSink = {
      put: () => {
        order.push('put');
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      tick: () => undefined,
    };
    const chunker = new Chunker(SAVE_CHUNK_BYTES * 3, sink);
    const pushing = chunker.push(bytesOf(SAVE_CHUNK_BYTES * 3));
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(['put']);
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(['put', 'put']);
    release();
    await pushing;
  });
});

describe('produceFile', () => {
  it('streams the file as it is, in its exact size', async () => {
    const bytes = bytesOf(SAVE_CHUNK_BYTES + 5);
    const sink = recorder();
    const last = await produceFile(input(bytes), { kind: 'eml', size: bytes.length }, sink);
    expect(sha(joined(sink.chunks, last))).toBe(sha(bytes));
  });

  it('an empty file is one empty last chunk, with nothing read', async () => {
    const sink = recorder();
    const last = await produceFile(null, { kind: 'eml', size: 0 }, sink);
    expect(last.length).toBe(0);
    expect(sink.chunks).toEqual([]);
  });

  it('a file that ends before the checked size fails as changed', async () => {
    const bytes = bytesOf(100);
    await expect(produceFile(input(bytes), { kind: 'eml', size: 101 }, recorder())).rejects.toEqual(
      new SaveStop('changed'),
    );
  });

  it('a read error fails as unreadable', async () => {
    const broken = new Readable({
      read() {
        this.destroy(new Error('EIO'));
      },
    });
    await expect(produceFile(broken, { kind: 'eml', size: 10 }, recorder())).rejects.toEqual(
      new SaveStop('unreadable'),
    );
  });
});

describe('producePart', () => {
  const att = bytesOf(SAVE_CHUNK_BYTES * 2 + 1234);
  const eml = message(att);
  const target = { kind: 'part' as const, path: '1.3', contentType: 'application/pdf' };

  it('streams the decoded bytes of the part at the listed path', async () => {
    const sink = recorder();
    const last = await producePart(input(eml), { ...target, size: att.length }, sink);
    expect(sha(joined(sink.chunks, last))).toBe(sha(att));
  });

  it('finds a part after a nested multipart by the same numbering', async () => {
    const sink = recorder();
    const second = Buffer.from('second file');
    const last = await producePart(
      input(eml),
      { kind: 'part', path: '1.4', contentType: 'application/octet-stream', size: second.length },
      sink,
    );
    expect(Buffer.from(last).toString()).toBe('second file');
  });

  it('a part with another type than listed fails as changed', async () => {
    await expect(
      producePart(
        input(eml),
        { ...target, contentType: 'image/png', size: att.length },
        recorder(),
      ),
    ).rejects.toEqual(new SaveStop('changed'));
  });

  it('a container at the path fails as changed', async () => {
    await expect(
      producePart(
        input(eml),
        { kind: 'part', path: '1.2', contentType: 'multipart/alternative', size: 0 },
        recorder(),
      ),
    ).rejects.toEqual(new SaveStop('changed'));
  });

  it('a path the message has no part at fails as changed', async () => {
    await expect(
      producePart(input(eml), { ...target, path: '1.9', size: 1 }, recorder()),
    ).rejects.toEqual(new SaveStop('changed'));
  });

  it('a part larger than listed fails as changed, and nothing completes', async () => {
    const sink = recorder();
    await expect(
      producePart(input(eml), { ...target, size: att.length - 1 }, sink),
    ).rejects.toEqual(new SaveStop('changed'));
    const sent = sink.chunks.reduce((n, c) => n + c.length, 0);
    expect(sent).toBeLessThan(att.length - 1);
  });

  it('a part smaller than listed fails as changed', async () => {
    await expect(
      producePart(input(eml), { ...target, size: att.length + 1 }, recorder()),
    ).rejects.toEqual(new SaveStop('changed'));
  });

  it('a read error before the part ends fails as unreadable', async () => {
    const cut = eml.subarray(0, Math.floor(eml.length / 2));
    const broken = Readable.from(
      (async function* () {
        yield cut;
        throw new Error('EIO');
      })(),
    );
    await expect(producePart(broken, { ...target, size: att.length }, recorder())).rejects.toEqual(
      new SaveStop('unreadable'),
    );
  });

  it('ticks while it reads towards a part far into the message', async () => {
    const big = bytesOf(12 * 1024 * 1024);
    const far = message(Buffer.from('x'), big);
    const sink = recorder();
    // The second attachment is quoted-printable latin1 text of the big bytes; only reach it.
    await producePart(input(far, 1024 * 1024), { ...target, size: 1 }, sink);
    expect(sink.ticks).toBe(0);
    const sink2 = recorder();
    await expect(
      producePart(
        input(far, 1024 * 1024),
        { kind: 'part', path: '1.9', contentType: 'x/y', size: 1 },
        sink2,
      ),
    ).rejects.toEqual(new SaveStop('changed'));
    expect(sink2.ticks).toBeGreaterThan(0);
  });
});
