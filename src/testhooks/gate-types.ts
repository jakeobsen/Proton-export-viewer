// SPDX-License-Identifier: AGPL-3.0-or-later
// What the gate mode of test builds records, shared by main and the shell's
// test hooks. Shell times are the shell's performance.now(); with the shell's
// timeOrigin they map onto main's clock.

/** Delivery of animation frames: from a DOM change to the next requestAnimationFrame. */
export interface RafProbe {
  /** Milliseconds from each change to its frame, for the frames that came. */
  samples: number[];
  /** Changes whose frame didn't come within the time limit. */
  timeouts: number;
  timeoutMs: number;
}

/** The first list rows the shell drew: the DOM change, and the frame after it. */
export interface FirstRows {
  /** When the first row was in the DOM; null if none came. */
  commitAt: number | null;
  /** The animation frame after it; null if it didn't come within the time limit. */
  rafAt: number | null;
  /** The wait for that frame has ended, with a frame or at its time limit. */
  settled: boolean;
  rows: number;
}

/** A scroll of one element, one step per animation frame (or per timer tick when none came). */
export interface ScrollRun {
  selector: string;
  steps: number;
  /** Steps that an animation frame drove. */
  byFrame: number;
  /** Steps a timer drove, after no frame came within the time limit. */
  byTimer: number;
  ms: number;
  /** The element's scroll range; 0 when there was nothing to scroll. */
  range: number;
}

/** A message to expand: its conversation, that conversation's newest message, and its place there. */
export interface ExpansionItem {
  rowid: number;
  threadId: number;
  newest: number;
  index: number;
}

/** One expansion, from just before the expand to the body frame's load. */
export interface TimedExpansion {
  rowid: number;
  ms: number | null;
  outcome: 'view' | 'timeout' | 'not-held' | 'not-expanded';
}

/** An index progress update as main sent it to the shell, on main's clock. */
export interface ProgressMark {
  at: number;
  phase: string;
  bodyPhase: string;
  loaded: number;
  total: number;
  bodiesDone: number;
  bodiesTotal: number;
}

/** A log event main wrote, on main's clock. */
export interface LogMark {
  at: number;
  code: string;
}
