// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Readable } from 'node:stream';

export function attachmentPartBytes(bytes: number): number;
export function largeMessage(options: {
  kind: 'text' | 'html' | 'attachment';
  bytes: number;
  seed?: number;
}): Readable & { partBytes: number };
