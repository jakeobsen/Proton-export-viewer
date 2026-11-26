// SPDX-License-Identifier: AGPL-3.0-or-later
// Records every show and focus event of every window, so a test run can prove
// that it stayed in the background: the record must be empty. A probe proves
// that the recorder is connected to a window, without showing or focusing it.

export const WINDOW_EVENTS = ['show', 'focus'] as const;

export type WindowEventName = (typeof WINDOW_EVENTS)[number];

export interface WindowEvent {
  /** The window's id (BrowserWindow.id). */
  window: number;
  event: WindowEventName;
}

/** The part of a BrowserWindow the recorder uses. */
export interface RecordedWindow {
  readonly id: number;
  on(event: WindowEventName, listener: () => void): unknown;
  emit(event: WindowEventName): boolean;
}

export class WindowEventRecorder {
  private readonly recorded: WindowEvent[] = [];
  /** Set while a probe runs: its events go here instead of into the record. */
  private probing: WindowEvent[] | null = null;

  /** Starts recording the window's show and focus events. */
  attach(win: RecordedWindow): void {
    const id = win.id;
    for (const event of WINDOW_EVENTS) {
      win.on(event, () => (this.probing ?? this.recorded).push({ window: id, event }));
    }
  }

  /** Every show and focus event recorded so far, in order. */
  events(): WindowEvent[] {
    return this.recorded.map((e) => ({ ...e }));
  }

  /**
   * Emits each event on the window object itself. That runs its listeners but
   * asks the system for nothing, so the window is neither shown nor focused.
   * Returns what the recorder saw, one entry per event for a connected window
   * and none for a window it isn't attached to. Probe events never enter the
   * record.
   */
  probe(win: RecordedWindow): WindowEvent[] {
    const seen: WindowEvent[] = [];
    this.probing = seen;
    try {
      for (const event of WINDOW_EVENTS) win.emit(event);
    } finally {
      this.probing = null;
    }
    return seen;
  }
}
