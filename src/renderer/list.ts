// SPDX-License-Identifier: AGPL-3.0-or-later
// The conversation list's model. The list is as long as the folder, but only
// a window of rows around what is on screen is held; the rest are drawn as
// blank rows of the same height. Each time the window is read again (the
// index moved on, or the view left the window), it is placed at an anchor:
// the selected row if it is on screen, else the top row on screen. The list
// then scrolls by however many rows the anchor moved, so rows that arrive
// above it never move it on screen. A selection is held by a message, never
// by a conversation ID, so it follows its message when conversations merge.

import {
  WINDOW_AFTER,
  type ListRow,
  type ListWindow,
  type RowDetails,
  type WindowAnchor,
  type WindowQuery,
} from '../shared/index-types';

/** Every row has this height, in pixels, so a position maps to an offset. */
export const ROW_HEIGHT = 82;
/** Rows read above the anchor, for scrolling up. */
export const READ_ABOVE = 50;
/** Rows beyond the screen that must be held before more are read. */
export const MARGIN = 10;

export interface Row extends ListRow {
  details: RowDetails | null;
}

export interface Selection {
  /** The message the selection holds. */
  rowid: number;
  /** The conversation it is in, as of the last read. */
  threadId: number | null;
}

export interface ListSnapshot {
  labelId: string | null;
  /** Conversations in the folder. */
  total: number;
  /** The position of the first row held. */
  start: number;
  rows: Row[];
  selected: Selection | null;
  /** Whether the folder has been read at least once. */
  ready: boolean;
  /** Bumped each time the list must scroll to keep its anchor in place. */
  shiftId: number;
  /** Rows to scroll by for `shiftId`; positive is down. */
  shift: number;
}

export type ReadWindow = (query: WindowQuery) => Promise<ListWindow | null>;

const EMPTY: ListSnapshot = {
  labelId: null,
  total: 0,
  start: 0,
  rows: [],
  selected: null,
  ready: false,
  shiftId: 0,
  shift: 0,
};

export class ListModel {
  private snap: ListSnapshot = EMPTY;
  private first = 0;
  private last = 0;
  private reading = false;
  private again = false;
  /** Folder changes since the start; a read for an older one is dropped. */
  private epoch = 0;

  constructor(
    private readonly read: ReadWindow,
    private readonly onChange: () => void,
  ) {}

  get snapshot(): ListSnapshot {
    return this.snap;
  }

  private set(patch: Partial<ListSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    this.onChange();
  }

  /** The row at a position, if it is held. */
  rowAt(index: number): Row | null {
    const i = index - this.snap.start;
    return i >= 0 && i < this.snap.rows.length ? this.snap.rows[i]! : null;
  }

  /** Shows a folder from its top, with nothing selected. */
  reset(labelId: string | null): void {
    this.epoch += 1;
    this.first = 0;
    this.last = 0;
    this.snap = { ...EMPTY, labelId, shiftId: this.snap.shiftId };
    this.onChange();
    this.refresh();
  }

  /** The positions on screen, first and last; reads more rows if they aren't held. */
  setViewport(first: number, last: number): void {
    this.first = Math.max(0, first);
    this.last = Math.max(this.first, last);
    if (!this.covered()) this.refresh();
  }

  private covered(): boolean {
    const { total, start, rows } = this.snap;
    if (total === 0) return true;
    const from = Math.max(0, this.first - MARGIN);
    const to = Math.min(total - 1, this.last + MARGIN);
    return from >= start && to < start + rows.length;
  }

  /** Reads the window again, e.g. because the index moved on. */
  refresh(): void {
    if (this.snap.labelId === null) return;
    if (this.reading) {
      this.again = true;
      return;
    }
    this.reading = true;
    void this.readOnce().finally(() => {
      this.reading = false;
      if (this.again || !this.covered()) {
        this.again = false;
        this.refresh();
      }
    });
  }

  /** The anchor: the selected row if it is on screen, else the top row on screen. */
  private anchor(): { anchor: WindowAnchor; index: number } {
    const selected = this.snap.selected;
    if (selected) {
      for (let i = this.first; i <= this.last; i += 1) {
        const row = this.rowAt(i);
        if (row && row.threadId === selected.threadId) {
          return { anchor: { rowid: selected.rowid, index: i }, index: i };
        }
      }
    }
    const top = this.rowAt(this.first);
    return top
      ? {
          anchor: {
            rowid: top.anchorRowid,
            key: { time: top.time, threadId: top.threadId },
            index: this.first,
          },
          index: this.first,
        }
      : { anchor: { index: this.first }, index: this.first };
  }

  private async readOnce(): Promise<void> {
    const labelId = this.snap.labelId;
    if (labelId === null) return;
    const epoch = this.epoch;
    const { anchor, index } = this.anchor();
    // The answer's selection is for this message, not one picked while it was read.
    const asked = this.snap.selected?.rowid ?? null;
    const screen = this.last - this.first + 1;
    const answer = await this.read({
      op: 'window',
      labelId,
      anchor,
      before: READ_ABOVE,
      after: Math.min(WINDOW_AFTER, screen + 2 * MARGIN + READ_ABOVE),
      selected: asked,
    });
    if (!answer || epoch !== this.epoch) return;
    const rows: Row[] = answer.rows.map((row, i) => {
      const details = answer.details[i];
      return { ...row, details: details?.threadId === row.threadId ? details : null };
    });
    // Without its anchor row the window was placed by position, so nothing moves.
    const moved = answer.anchor === null ? 0 : answer.anchor - index;
    // A selection made while this was read is kept, and read again.
    let selected = this.snap.selected;
    if ((selected?.rowid ?? null) === asked) {
      selected =
        asked !== null && answer.selected !== null
          ? { rowid: asked, threadId: answer.selected }
          : null;
    } else {
      this.again = true;
    }
    this.set({
      total: answer.total,
      start: answer.start,
      rows,
      ready: true,
      selected,
      ...(moved !== 0 ? { shiftId: this.snap.shiftId + 1, shift: moved } : {}),
    });
    // The screen moves with the anchor.
    this.first = Math.max(0, this.first + moved);
    this.last = Math.max(this.first, this.last + moved);
  }

  /** Selects a row: the selection holds the row's newest message here. */
  select(row: Row): void {
    this.set({ selected: { rowid: row.anchorRowid, threadId: row.threadId } });
  }

  /** The position of the selected row, if it is held. */
  selectedIndex(): number | null {
    const selected = this.snap.selected;
    if (!selected) return null;
    const i = this.snap.rows.findIndex((r) => r.threadId === selected.threadId);
    return i < 0 ? null : this.snap.start + i;
  }
}
