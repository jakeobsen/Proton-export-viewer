// SPDX-License-Identifier: AGPL-3.0-or-later
// What the open bench of test builds records for each open, shared by main
// and the shell's test hooks.

/** One open, timed from just before the open request to the body frame's `load`. */
export interface TimedOpen {
  rowid: number;
  /** Milliseconds; null when no view was shown. */
  ms: number | null;
  /** 'timeout': the view was shown but the frame didn't load in time. */
  outcome: 'view' | 'fallback' | 'rejected' | 'timeout';
  /** Why the open was refused, for 'rejected'. */
  code?: string;
  format?: 'plain' | 'html';
}
