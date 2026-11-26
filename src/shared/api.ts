// SPDX-License-Identifier: AGPL-3.0-or-later
// The typed surface between the shell renderer and the main process.

import type { MessageHeaders, OpenMode } from './reader-protocol';
import type { SourceOutcome, SourcesView } from './sources';

export const IPC = {
  state: 'pev:state',
  ping: 'pev:ping',
  openStub: 'pev:open-stub',
  open: 'pev:open',
  log: 'pev:log',
  report: 'pev:report',
  linkDialog: 'pev:link-dialog',
  sources: 'pev:sources',
  chooseFolder: 'pev:choose-folder',
  openExport: 'pev:open-export',
  switchRun: 'pev:switch-run',
  locateExport: 'pev:locate-export',
  forgetExport: 'pev:forget-export',
  sourcesChanged: 'pev:sources-changed',
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
  | 'unknown_source'
  | 'unknown_run'
  | 'no_source'
  | 'not_found';

export type Rejected = { ok: false; code: RejectCode };

export type StateResult = { ok: true; generation: number } | Rejected;
export type PingResult = { ok: true; generation: number } | Rejected;
export type OpenResult = { ok: true; openId: number; url: string } | Rejected;
export type SourcesResult = { ok: true; generation: number; sources: SourcesView } | Rejected;
/** The outcome of an open, a switch, a Locate or a Forget, and the generation it left. */
export type SourceActionResult =
  { ok: true; outcome: SourceOutcome; generation: number } | Rejected;

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
      /** How many distinct remote images the body refers to; they show as placeholders. */
      remote: number;
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
  sources(generation: number): Promise<SourcesResult>;
  chooseFolder(generation: number): Promise<SourceActionResult>;
  openExport(sourceKey: string, generation: number): Promise<SourceActionResult>;
  switchRun(runId: string, generation: number): Promise<SourceActionResult>;
  locateExport(generation: number): Promise<SourceActionResult>;
  /** Removes an export from the app and deletes its index; its files stay as they are. */
  forgetExport(sourceKey: string, generation: number): Promise<SourceActionResult>;
  /** Called when the open export or the list of exports changed. */
  onSourcesChanged(listener: () => void): () => void;
}
