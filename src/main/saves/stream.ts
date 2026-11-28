// SPDX-License-Identifier: AGPL-3.0-or-later
// A save's bytes as a response body, pulled from core one chunk at a time and
// only as fast as the download takes them: at most QUEUE_BYTES wait here, and
// one more chunk is on its way.

import { SAVE_CHUNK_BYTES } from '../../shared/save-protocol';

/** Bytes queued in main before it pulls more. */
export const QUEUE_BYTES = 4 * SAVE_CHUNK_BYTES;

export interface Pull {
  chunk: Uint8Array;
  done: boolean;
}

/**
 * A body that pulls with `next` whenever its queue has room. A rejected pull
 * errors the body, so the download ends interrupted; a body the download
 * gives up on calls `onCancel`.
 */
export function pullBody(
  next: () => Promise<Pull>,
  onCancel: () => void,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const { chunk, done } = await next();
        if (chunk.byteLength > 0) controller.enqueue(chunk);
        if (done) controller.close();
      },
      cancel() {
        onCancel();
      },
    },
    { highWaterMark: QUEUE_BYTES, size: (chunk) => chunk.byteLength },
  );
}
