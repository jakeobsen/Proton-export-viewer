// SPDX-License-Identifier: AGPL-3.0-or-later
// The folder dialog and folder scopes, as the source manager sees them.

export interface Picked {
  path: string;
  bookmark: string | null;
}

/** Shows the folder dialog; null when it was cancelled. */
export type Picker = (win: Electron.BrowserWindow | null) => Promise<Picked | null>;

export interface ScopeHandle {
  release(): void;
}

/** A scope that couldn't be started: the bookmark is missing, stale or failing. */
export class ScopeError extends Error {}

export interface Scopes {
  /** Starts access to a picked folder; throws ScopeError when it can't. */
  start(bookmark: string | null): ScopeHandle;
}
