// SPDX-License-Identifier: AGPL-3.0-or-later
// Reader-worker test hooks: message inputs that exist only to test the reader
// lane. Large messages are generated while they are read and never stored;
// the other inputs breach the lane's limits or fail on purpose.

import { Readable } from 'node:stream';
import { largeMessage } from '../../tools/gen-export/stream.mjs';
import type { TestInput } from '../shared/reader-protocol';
import { markLoaded } from './marker';

markLoaded();

let spins = 0;
const held: number[][] = [];

export function testStream(input: TestInput): Readable {
  switch (input.kind) {
    case 'generated':
      return largeMessage(input.spec);
    case 'spin':
      // Never yields: only the lane's wall-clock limit ends it.
      return new Readable({
        read() {
          for (;;) spins += 1;
        },
      });
    case 'heap':
      // Keeps allocating until the worker's heap limit ends it.
      return new Readable({
        read() {
          for (;;) held.push(new Array<number>(100_000).fill(spins));
        },
      });
    case 'throw':
      throw new Error(input.markers);
    case 'sleep':
      // Holds the job for a while without blocking the worker, then gives a small message.
      return Readable.from(
        (async function* () {
          await new Promise((resolve) => setTimeout(resolve, input.ms));
          yield Buffer.from('Subject: slept\r\n\r\nslept\r\n');
        })(),
      );
  }
}
