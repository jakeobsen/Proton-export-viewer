// SPDX-License-Identifier: AGPL-3.0-or-later
// The fetcher tests' dual-protocol server joins each client connection to an
// internal server's. A back connection that ends and closes while the client
// is still reading must not cut off the bytes not yet flushed to the client;
// a failed back connection and a client that goes away close the other side.

import { once } from 'node:events';
import { Duplex } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { bridge } from '../dual-server';

/** The internal server's side: the test pushes its bytes. */
function fakeBack(): Duplex {
  const back = new Duplex({ read() {}, write: (_c, _e, cb) => cb() });
  back.on('error', () => undefined);
  return back;
}

/** A client that doesn't read until released: what is written to it stays pending. */
function slowFront() {
  const got: Buffer[] = [];
  let open = false;
  let pending: (() => void) | null = null;
  const front = new Duplex({
    read() {},
    write(chunk: Buffer, _e, cb) {
      got.push(chunk);
      if (open) cb();
      else pending = cb;
    },
  });
  const release = () => {
    open = true;
    pending?.();
    pending = null;
  };
  return { front, got, release };
}

describe('dual server bridge', () => {
  it('a back connection that ends and closes leaves the client every byte', async () => {
    const { front, got, release } = slowFront();
    const back = fakeBack();
    bridge(front, back);
    back.push(Buffer.alloc(1000, 1));
    back.push(Buffer.alloc(2000, 2));
    back.push(null);
    await once(back, 'end');
    back.destroy();
    await once(back, 'close');
    // The client hasn't read yet: its side is ended, not destroyed, with the bytes still queued.
    expect(front.destroyed).toBe(false);
    expect(front.writableEnded).toBe(true);
    expect(front.writableLength).toBeGreaterThan(0);
    const finished = once(front, 'finish');
    release();
    await finished;
    expect(Buffer.concat(got).length).toBe(3000);
  });

  it('a back connection that fails cuts the client off at once', async () => {
    const { front } = slowFront();
    const back = fakeBack();
    bridge(front, back);
    back.push(Buffer.alloc(1000));
    // once() would reject on the 'error' that comes first.
    const closed = new Promise((resolve) => back.on('close', resolve));
    back.destroy(new Error('reset'));
    await closed;
    expect(front.destroyed).toBe(true);
  });

  it('a client that goes away closes the back connection', async () => {
    const { front } = slowFront();
    const back = fakeBack();
    bridge(front, back);
    front.destroy();
    await once(front, 'close');
    expect(back.destroyed).toBe(true);
  });
});
