// SPDX-License-Identifier: AGPL-3.0-or-later
// Saving an attachment or a whole message file: the messages between main and
// core, and between core and its save worker.
//
// Main pulls a save's bytes from core one chunk at a time. Core holds at most
// one chunk ready, and its worker makes the next only once that one is taken,
// so a save of any size keeps a few chunks in memory. The chunk that completes
// the save is sent only after the file has been checked again.

import type { FileIdentity, FileVersion } from './reader-protocol';

/** The most bytes one chunk carries. */
export const SAVE_CHUNK_BYTES = 512 * 1024;

/** A save that makes no progress for this long fails. */
export const SAVE_IDLE_MS = 30_000;

/** What a save streams: one part's decoded bytes, or the message file as it is. */
export type SaveTarget =
  | { kind: 'eml'; size: number }
  | {
      kind: 'part';
      /** The part's dotted path, as the reader numbered it. */
      path: string;
      /** The part's type as the view listed it: the save checks that the part still has it. */
      contentType: string;
      /** The decoded size the view listed: exactly this many bytes are saved. */
      size: number;
    };

/** main -> core: open a save of one message, for a view of the current generation. */
export interface SaveOpenRequest {
  type: 'save-open';
  reqId: number;
  saveId: number;
  generation: number;
  rowid: number;
  /** The file the view was read from, and its size and time then. */
  file: FileIdentity;
  version: FileVersion;
  target: SaveTarget;
}

/** main -> core: the next chunk of an open save. */
export interface SavePullRequest {
  type: 'save-pull';
  reqId: number;
  saveId: number;
}

/** main -> core: end a save early. Answered once it has ended. */
export interface SaveCancelRequest {
  type: 'save-cancel';
  reqId: number;
  saveId: number;
}

export type SaveRequest = SaveOpenRequest | SavePullRequest | SaveCancelRequest;

/** Why a save failed in core. */
export const SAVE_FAILURES = [
  // The file isn't the one the view was read from, or changed while it was saved.
  'changed',
  // It couldn't be read.
  'unreadable',
  // No progress for SAVE_IDLE_MS.
  'stalled',
  // It was cancelled.
  'cancelled',
] as const;
export type SaveFailure = (typeof SAVE_FAILURES)[number];

/** core -> save worker. */
export type SaveWorkerIn =
  /** `fileSize` is the size the file was checked to have: nothing past it is read. */
  | { type: 'start'; fd: number; fileSize: number; target: SaveTarget }
  /** The last chunk was taken: make the next. */
  | { type: 'more' };

/** save worker -> core. Each chunk's buffer is handed over, not copied. */
export type SaveWorkerOut =
  | { type: 'chunk'; bytes: Uint8Array }
  /** The bytes that complete the save, sent once the input has ended and the count is right. */
  | { type: 'last'; bytes: Uint8Array }
  /** Still reading towards the part, with nothing to send yet. */
  | { type: 'tick' }
  | { type: 'failed'; reason: 'changed' | 'unreadable' }
  | { type: 'log'; level: 'error' | 'warn' | 'info'; code: string; data?: Record<string, unknown> };
