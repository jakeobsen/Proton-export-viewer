// SPDX-License-Identifier: AGPL-3.0-or-later
// The typed surface between the shell renderer and the main process.

import type { MessageHeaders, OpenMode } from './reader-protocol';

export const IPC = {
  state: 'pev:state',
  ping: 'pev:ping',
  openStub: 'pev:open-stub',
  open: 'pev:open',
  log: 'pev:log',
  report: 'pev:report',
  linkDialog: 'pev:link-dialog',
} as const;

export type RejectCode =
  | 'invalid'
  | 'unknown_window'
  | 'not_main_frame'
  | 'bad_origin'
  | 'stale_generation'
  | 'superseded'
  | 'unknown_stub'
  | 'core_unavailable'
  | 'no_source'
  | 'not_found';

export type Rejected = { ok: false; code: RejectCode };

export type StateResult = { ok: true; generation: number } | Rejected;
export type PingResult = { ok: true; generation: number } | Rejected;
export type OpenResult = { ok: true; openId: number; url: string } | Rejected;

/**
 * The outcome of opening a message: its body view, or the fallback when the
 * reader couldn't render it.
 */
export type MessageOpenResult =
  | {
      ok: true;
      openId: number;
      outcome: 'view';
      url: string;
      format: 'plain' | 'html';
      hasHtml: boolean;
      headers: MessageHeaders;
    }
  | { ok: true; openId: number; outcome: 'fallback' }
  | Rejected;

export type ErrorKind = 'uncaught' | 'rejection' | 'error';

export interface ErrorReport {
  generation: number;
  kind: ErrorKind;
  errorClass: string;
  frames: string[];
}

export interface PevApi {
  state(): Promise<StateResult>;
  ping(generation: number): Promise<PingResult>;
  openStub(id: string, generation: number): Promise<OpenResult>;
  open(rowid: number, mode: OpenMode, generation: number): Promise<MessageOpenResult>;
  log(
    level: 'error' | 'warn' | 'info',
    code: string,
    generation: number,
    data?: Record<string, unknown>,
  ): void;
  reportError(report: ErrorReport): void;
  onLinkDialog(listener: (url: string) => void): () => void;
}
