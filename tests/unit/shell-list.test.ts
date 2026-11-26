// SPDX-License-Identifier: AGPL-3.0-or-later
// The conversation list's model in the shell: windows read around an anchor,
// the scroll that keeps the anchor in place as rows arrive, and a selection
// held by its message.

import { describe, expect, it } from 'vitest';
import type { ListRow, ListWindow, WindowQuery } from '../../src/shared/index-types';
import { ListModel } from '../../src/renderer/list';

/** A folder of conversations, newest first; each conversation's newest message is its anchor. */
class Folder {
  rows: ListRow[] = [];
  /** message rowid -> conversation */
  messages = new Map<number, number>();
  queries: WindowQuery[] = [];

  add(threadId: number, time: number, rowid = threadId * 10): void {
    this.rows.push({
      threadId,
      time,
      count: 1,
      unread: 0,
      unreadHere: 0,
      attachments: false,
      anchorRowid: rowid,
    });
    this.messages.set(rowid, threadId);
    this.rows.sort((a, b) => b.time - a.time || b.threadId - a.threadId);
  }

  /** Conversation `from` merges into `into`: its messages move there. */
  merge(from: number, into: number): void {
    this.rows = this.rows.filter((r) => r.threadId !== from);
    for (const [rowid, thread] of this.messages)
      if (thread === from) this.messages.set(rowid, into);
  }

  read = (q: WindowQuery): Promise<ListWindow> => {
    this.queries.push(q);
    const at = (thread: number | undefined) => this.rows.findIndex((r) => r.threadId === thread);
    let index = q.anchor.rowid !== undefined ? at(this.messages.get(q.anchor.rowid)) : -1;
    if (index < 0 && q.anchor.key) index = at(q.anchor.key.threadId);
    const found = index >= 0;
    if (!found) index = Math.max(0, Math.min(q.anchor.index, this.rows.length - 1));
    const start = Math.max(0, index - q.before);
    const rows = this.rows.slice(start, index + q.after);
    return Promise.resolve({
      total: this.rows.length,
      start,
      rows,
      details: rows.map((r) => ({
        threadId: r.threadId,
        subject: '',
        participants: [],
        labelIds: [],
      })),
      anchor: found ? index : null,
      selected: q.selected === null ? null : (this.messages.get(q.selected) ?? null),
    });
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

function model(folder: Folder) {
  let changes = 0;
  const list = new ListModel(folder.read, () => (changes += 1));
  return { list, changes: () => changes };
}

describe('the list model', () => {
  it('reads the folder from its top, and more when the screen moves past what it holds', async () => {
    const folder = new Folder();
    for (let i = 1; i <= 1000; i += 1) folder.add(i, i);
    const { list } = model(folder);
    list.reset('5');
    await settle();
    list.setViewport(0, 9);
    await settle();
    expect(list.snapshot).toMatchObject({ total: 1000, start: 0, ready: true });
    expect(list.rowAt(0)?.threadId).toBe(1000);
    const reads = folder.queries.length;
    // Within what it holds: no read.
    list.setViewport(20, 29);
    await settle();
    expect(folder.queries.length).toBe(reads);
    // Far away: a read placed at the new screen.
    list.setViewport(600, 609);
    await settle();
    expect(list.rowAt(600)?.threadId).toBe(400);
    expect(list.rowAt(609)?.threadId).toBe(391);
  });

  it('keeps the top row in place on screen when rows arrive above it', async () => {
    const folder = new Folder();
    for (let i = 1; i <= 50; i += 1) folder.add(i, i * 10);
    const { list } = model(folder);
    list.reset('5');
    list.setViewport(5, 14);
    await settle();
    const top = list.rowAt(5)!;
    const shiftBefore = list.snapshot.shiftId;
    // Three newer conversations and two older ones arrive.
    folder.add(101, 10_000);
    folder.add(102, 10_001);
    folder.add(103, 10_002);
    folder.add(104, 1);
    folder.add(105, 2);
    list.refresh();
    await settle();
    expect(list.snapshot.total).toBe(55);
    expect(list.snapshot.shiftId).toBe(shiftBefore + 1);
    expect(list.snapshot.shift).toBe(3);
    expect(list.rowAt(8)?.threadId).toBe(top.threadId);
    // Nothing arrives: no shift.
    list.setViewport(8, 17);
    list.refresh();
    await settle();
    expect(list.snapshot.shiftId).toBe(shiftBefore + 1);
  });

  it('anchors on the selected row while it is on screen', async () => {
    const folder = new Folder();
    for (let i = 1; i <= 50; i += 1) folder.add(i, i * 10);
    const { list } = model(folder);
    list.reset('5');
    list.setViewport(0, 9);
    await settle();
    list.select(list.rowAt(6)!);
    folder.add(200, 10_000);
    folder.add(201, 10_001);
    list.refresh();
    await settle();
    expect(list.snapshot.shift).toBe(2);
    expect(list.selectedIndex()).toBe(8);
    expect(folder.queries.at(-1)?.anchor).toMatchObject({ rowid: 440, index: 6 });
  });

  it('follows the selected message into the conversation it was merged into', async () => {
    const folder = new Folder();
    folder.add(1, 100, 11);
    folder.add(2, 200, 21);
    folder.add(3, 300, 31);
    const { list } = model(folder);
    list.reset('5');
    list.setViewport(0, 9);
    await settle();
    list.select(list.rowAt(1)!);
    expect(list.snapshot.selected).toEqual({ rowid: 21, threadId: 2 });
    folder.merge(2, 1);
    list.refresh();
    await settle();
    expect(list.snapshot.selected).toEqual({ rowid: 21, threadId: 1 });
    expect(list.rowAt(list.selectedIndex()!)?.threadId).toBe(1);
    // The message is gone: nothing is selected.
    folder.rows = folder.rows.filter((r) => r.threadId !== 1);
    folder.messages.delete(21);
    folder.messages.delete(11);
    list.refresh();
    await settle();
    expect(list.snapshot.selected).toBeNull();
  });

  it('keeps a selection made while a read is out, and reads again for it', async () => {
    const folder = new Folder();
    folder.add(1, 100, 10);
    folder.add(2, 200, 20);
    let release!: () => void;
    let hold = false;
    const reads: WindowQuery[] = [];
    const list = new ListModel(
      async (q) => {
        reads.push(q);
        if (hold) {
          hold = false;
          await new Promise<void>((r) => (release = r));
        }
        return folder.read(q);
      },
      () => undefined,
    );
    list.reset('5');
    list.setViewport(0, 9);
    await settle();
    // A read for rowid 10 is out when rowid 20 is selected.
    list.select(list.rowAt(1)!);
    expect(list.snapshot.selected).toEqual({ rowid: 10, threadId: 1 });
    hold = true;
    list.refresh();
    await settle();
    list.select(list.rowAt(0)!);
    expect(list.snapshot.selected).toEqual({ rowid: 20, threadId: 2 });
    release();
    await settle();
    await settle();
    expect(list.snapshot.selected).toEqual({ rowid: 20, threadId: 2 });
    expect(reads.at(-1)?.selected).toBe(20);

    // A read that began with nothing selected doesn't clear a click.
    const fresh = new ListModel(
      async (q) => {
        reads.push(q);
        if (hold) {
          hold = false;
          await new Promise<void>((r) => (release = r));
        }
        return folder.read(q);
      },
      () => undefined,
    );
    hold = true;
    fresh.reset('5');
    fresh.setViewport(0, 9);
    await settle();
    fresh.select({ ...folder.rows[1]!, details: null });
    release();
    await settle();
    await settle();
    expect(fresh.snapshot.selected).toEqual({ rowid: 10, threadId: 1 });
    expect(reads.at(-1)?.selected).toBe(10);
  });

  it('reads one window at a time, and drops a read made for another folder', async () => {
    const folder = new Folder();
    for (let i = 1; i <= 30; i += 1) folder.add(i, i);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const reads: WindowQuery[] = [];
    const list = new ListModel(
      async (q) => {
        reads.push(q);
        if (reads.length === 1) await held;
        return folder.read(q);
      },
      () => undefined,
    );
    list.reset('0');
    list.refresh();
    list.refresh();
    expect(reads).toHaveLength(1);
    list.reset('5');
    release();
    await settle();
    await settle();
    expect(list.snapshot.labelId).toBe('5');
    expect(reads.map((q) => q.labelId)).toEqual(['0', '5']);
    expect(list.snapshot.ready).toBe(true);
  });
});
