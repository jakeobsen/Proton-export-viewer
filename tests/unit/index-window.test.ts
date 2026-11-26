// SPDX-License-Identifier: AGPL-3.0-or-later
// List windows: a stretch of a folder's conversations around an anchor, read
// from one snapshot, with each row's position.

import { describe, expect, it } from 'vitest';
import { listPage, listWindow } from '../../src/core/index/queries';
import { asNumber, type Db } from '../../src/core/index/sql';
import type { ListWindow, WindowAnchor } from '../../src/shared/index-types';
import { fresh, ingest, message } from '../index-helpers';

const rowidOf = (db: Db, id: string) =>
  asNumber(db.stmt('SELECT rowid FROM messages WHERE proton_id = ?').get(id)?.rowid);

const window = (
  db: Db,
  anchor: WindowAnchor,
  before = 3,
  after = 4,
  selected: number | null = null,
  labelId = '5',
): ListWindow => listWindow(db, { labelId, anchor, before, after, selected });

/** 20 conversations of one message each, at times 100..119, some with the same time. */
function twenty() {
  const { db, writer } = fresh();
  const rows = Array.from({ length: 20 }, (_, i) =>
    message(`m${i}`, [`m${i}`], { time: 100 + i - (i % 4 === 1 ? 1 : 0), labelIds: ['5'] }),
  );
  ingest(writer, rows, 6);
  const all = listPage(db, '5', null).rows;
  return { db, writer, all };
}

describe('list windows', () => {
  it('places the window at the conversation that holds a message, with its position', () => {
    const { db, all } = twenty();
    for (const at of [0, 1, 7, 19]) {
      const w = window(db, { rowid: all[at]!.anchorRowid, index: 0 });
      expect(w.total).toBe(20);
      expect(w.anchor).toBe(at);
      expect(w.start).toBe(Math.max(0, at - 3));
      const expected = all.slice(Math.max(0, at - 3), at + 4);
      expect(w.rows.map((r) => r.threadId)).toEqual(expected.map((r) => r.threadId));
      expect(w.details.map((d) => d.threadId)).toEqual(expected.map((r) => r.threadId));
    }
    db.close();
  });

  it('falls back to the conversation key, then to the position', () => {
    const { db, all } = twenty();
    const byKey = window(db, {
      rowid: 999_999,
      key: { time: all[5]!.time, threadId: all[5]!.threadId },
      index: 0,
    });
    expect(byKey.anchor).toBe(5);
    expect(byKey.rows[byKey.anchor! - byKey.start]!.threadId).toBe(all[5]!.threadId);
    const byIndex = window(db, { key: { time: 1, threadId: 999_999 }, index: 12 });
    expect(byIndex.anchor).toBeNull();
    expect(byIndex.start).toBe(9);
    expect(byIndex.rows[3]!.threadId).toBe(all[12]!.threadId);
    // A position past the end is the last row.
    expect(window(db, { index: 500 }, 0, 5).rows.map((r) => r.threadId)).toEqual([
      all[19]!.threadId,
    ]);
    db.close();
  });

  it('is empty for a folder with no conversations', () => {
    const { db } = twenty();
    expect(window(db, { index: 0 }, 3, 4, null, '0')).toEqual({
      total: 0,
      start: 0,
      rows: [],
      details: [],
      anchor: null,
      selected: null,
    });
    db.close();
  });

  it('moves the anchor by the rows that arrived before it, and keeps it on its conversation', () => {
    const { db, writer } = fresh();
    const old = Array.from({ length: 10 }, (_, i) =>
      message(`o${i}`, [`o${i}`], { time: 100 + i }),
    );
    ingest(writer, old, 10);
    const first = listPage(db, '5', null).rows;
    const anchor = first[4]!;
    expect(window(db, { rowid: anchor.anchorRowid, index: 4 }).anchor).toBe(4);
    // Three newer and two older conversations arrive.
    ingest(
      writer,
      [200, 201, 202, 1, 2].map((t, i) => message(`n${i}`, [`n${i}`], { time: t })),
      5,
    );
    const w = window(db, { rowid: anchor.anchorRowid, index: 4 });
    expect(w.total).toBe(15);
    expect(w.anchor).toBe(7);
    expect(w.rows[w.anchor! - w.start]!.threadId).toBe(anchor.threadId);
    db.close();
  });

  it('finds a selected message’s conversation after a merge retired the one it was in', () => {
    const { db, writer } = fresh();
    ingest(
      writer,
      [
        message('a1', ['a1'], { time: 10 }),
        message('a2', ['a2', 'a1'], { time: 11 }),
        message('b1', ['b1'], { time: 12 }),
      ],
      3,
    );
    const b1 = rowidOf(db, 'b1');
    const before = window(db, { rowid: b1, index: 0 }, 3, 4, b1);
    expect(before.total).toBe(2);
    const bThread = before.selected!;
    expect(before.rows[0]!.threadId).toBe(bThread);
    // A message that links both: the smaller conversation is merged away.
    ingest(writer, [message('c1', ['c1', 'a1', 'b1'], { time: 13 })], 1);
    const after = window(db, { rowid: b1, index: 0 }, 3, 4, b1);
    expect(after.total).toBe(1);
    expect(after.selected).not.toBe(bThread);
    expect(after.anchor).toBe(0);
    expect(after.rows.map((r) => [r.threadId, r.count])).toEqual([[after.selected, 4]]);
    db.close();
  });

  it('caps how many rows it reads around the anchor', () => {
    const { db, writer } = fresh();
    ingest(
      writer,
      Array.from({ length: 400 }, (_, i) => message(`m${i}`, [`m${i}`], { time: i })),
      200,
    );
    const w = window(db, { index: 200 }, 10_000, 10_000);
    expect(w.rows).toHaveLength(100 + 200);
    expect(w.start).toBe(100);
    expect(w.details).toHaveLength(300);
    db.close();
  });
});
