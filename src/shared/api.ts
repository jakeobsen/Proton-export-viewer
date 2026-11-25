// SPDX-License-Identifier: AGPL-3.0-or-later
// The typed surface between the shell renderer and the main process.

export const IPC = {
  state: 'pev:state',
  ping: 'pev:ping',
  openStub: 'pev:open-stub',
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
  | 'core_unavailable';

export type Rejected = { ok: false; code: RejectCode };

export type StateResult = { ok: true; generation: number } | Rejected;
export type PingResult = { ok: true; generation: number } | Rejected;
export type OpenResult = { ok: true; openId: number; url: string } | Rejected;

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
  log(
    level: 'error' | 'warn' | 'info',
    code: string,
    generation: number,
    data?: Record<string, unknown>,
  ): void;
  reportError(report: ErrorReport): void;
  onLinkDialog(listener: (url: string) => void): () => void;
}
