// SPDX-License-Identifier: AGPL-3.0-or-later
// Closing the app and confirming its core process is gone. Core can outlive
// main for a moment with the index still open, so a close returns only once
// core's exit is confirmed. When it can't be confirmed (main named no core,
// or didn't answer) and an index was open, the close fails and says why,
// instead of letting the next read of the index fail with a lock error.

import { AliveAfterClose, type GoneState, type Waited } from './process-wait';

/** How a close's wait for core ended. */
export type CloseState = GoneState | 'no_core' | 'no_answer' | 'timeout';

/** One close, as test-output/close-waits.jsonl records it: numbers and fixed words only. */
export interface CloseWait {
  state: CloseState;
  ms?: number;
  /** The thread count of each probe that saw a Linux zombie leader. */
  zTasks?: number[];
}

export interface CloseEvidence {
  /** Whether an export was open when the close began; null when main didn't say. */
  sourceOpen: boolean | null;
  /** `index.opened` lines in the app's logs when it launched, and after it closed. */
  openedAtLaunch: number;
  openedAtClose: number;
}

/**
 * Why a close fails, or null when it may return. A close whose core exit
 * wasn't confirmed fails if an index was open: by main's answer when it gave
 * one, otherwise by this launch's own `index.opened` lines (an earlier launch
 * with the same user data logged its own).
 */
export function closeVerdict(state: CloseState, evidence: CloseEvidence): string | null {
  if (state !== 'no_core' && state !== 'no_answer') return null;
  const openedThisLaunch = evidence.openedAtClose > evidence.openedAtLaunch;
  const indexOpen =
    state === 'no_core' && evidence.sourceOpen !== null ? evidence.sourceOpen : openedThisLaunch;
  return indexOpen ? `close_unconfirmed: ${state}` : null;
}

export interface CloseSteps {
  /** Main's answer for core's process ID: undefined when there is no core. */
  corePid(): Promise<number | undefined>;
  /** Whether an export is open, by main's answer. */
  sourceOpen(): Promise<boolean>;
  startTimeOf(pid: number): string | null;
  closeApp(): Promise<void>;
  waitGone(pid: number, startTime: string | null): Promise<Waited>;
  /** `index.opened` lines in the app's logs now. */
  openedCount(): number;
  openedAtLaunch: number;
  record(entry: CloseWait): void;
}

/**
 * Closes the app, and returns once core is gone. Whatever main answered, the
 * app is closed and the outcome recorded before the close fails.
 */
export async function closeAndConfirm(steps: CloseSteps): Promise<CloseWait> {
  let pid: number | undefined | null;
  try {
    pid = await steps.corePid();
  } catch {
    // Main didn't answer: there is no pid to wait for.
    pid = null;
  }
  let sourceOpen: boolean | null;
  try {
    sourceOpen = await steps.sourceOpen();
  } catch {
    sourceOpen = null;
  }
  const startTime = typeof pid === 'number' ? steps.startTimeOf(pid) : null;
  await steps.closeApp().catch(() => undefined);
  if (typeof pid !== 'number') {
    const entry: CloseWait = { state: pid === null ? 'no_answer' : 'no_core' };
    steps.record(entry);
    const verdict = closeVerdict(entry.state, {
      sourceOpen,
      openedAtLaunch: steps.openedAtLaunch,
      openedAtClose: steps.openedCount(),
    });
    if (verdict !== null) throw new Error(verdict);
    return entry;
  }
  let waited: Waited;
  try {
    waited = await steps.waitGone(pid, startTime);
  } catch (err) {
    if (err instanceof AliveAfterClose) {
      steps.record({
        state: 'timeout',
        ms: err.ms,
        ...(err.zTasks.length > 0 ? { zTasks: err.zTasks } : {}),
      });
    }
    throw err;
  }
  steps.record(waited);
  return waited;
}
