// SPDX-License-Identifier: AGPL-3.0-or-later
// Cards windows: a stretch of one conversation's messages from every folder,
// oldest first, around an anchor, read from one snapshot.

import { describe, expect, it } from 'vitest';
import { cardsWindow, rowDetails, type CardsStretch } from '../../src/core/index/queries';
import { asNumber, type Db } from '../../src/core/index/sql';
import { CARDS_AFTER, CARDS_BEFORE, type CardsAnchor } from '../../src/shared/index-types';
import { fresh, ingest, message } from '../index-helpers';

const rowidOf = (db: Db, id: string) =>
  asNumber(db.stmt('SELECT rowid FROM messages WHERE proton_id = ?').get(id)?.rowid);
const threadOf = (db: Db, id: string) =>
  asNumber(db.stmt('SELECT thread_id FROM messages WHERE proton_id = ?').get(id)?.thread_id);

const cards = (
  db: Db,
  follow: number[],
  anchor: CardsAnchor,
  before = 3,
  after = 4,
  threadId: number | null = null,
): CardsStretch => cardsWindow(db, { follow, threadId, anchor, before, after });

/**
 * One conversation of 12 messages at times 100..111 (two share time 105), in
 * Inbox, Sent, Spam and Trash, plus a one-message conversation.
 */
function thread() {
  const { db, writer } = fresh();
  const labels = (i: number) =>
    i === 3 ? ['4', '5'] : i === 6 ? ['3', '5'] : i % 2 ? ['2', '5', '7'] : ['0', '5'];
  const rows = Array.from({ length: 12 }, (_, i) =>
    message(`t${i}`, i === 0 ? ['t0'] : [`t${i}`, 't0'], {
      time: i === 6 ? 105 : 100 + i,
      subject: `Subject ${i}`,
      sender: { name: `Sender ${i}`, address: `s${i}@example.com` },
      labelIds: labels(i),
    }),
  );
  rows.push(message('other', ['other'], { time: 50, labelIds: ['0', '5'] }));
  ingest(writer, rows, 5);
  // Oldest first: by time, then rowid (t5 and t6 share time 105).
  const order = ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10', 't11'];
  return { db, writer, order, ids: order.map((id) => rowidOf(db, id)) };
}

describe('cards windows', () => {
  it('lists the conversation from every folder, oldest first, with sender, date and badges', () => {
    const { db, ids } = thread();
    const w = cards(db, [ids[11]!], { rowid: ids[11]!, index: 0 }, 20, 20);
    expect(w.total).toBe(12);
    expect(w.subject).toBe('Subject 0');
    expect(w.start).toBe(0);
    expect(w.anchor).toBe(11);
    expect(w.anchorFound).toBe(true);
    expect(w.cards.map((c) => c.rowid)).toEqual(ids);
    expect(w.cards[3]).toMatchObject({ spam: true, trash: false, senderName: 'Sender 3' });
    expect(w.cards[6]).toMatchObject({ spam: false, trash: true, time: 105 });
    expect(w.cards[1]).toMatchObject({
      spam: false,
      trash: false,
      senderAddress: 's1@example.com',
      time: 101,
    });
    expect(w.threadId).toBe(threadOf(db, 't0'));
    db.close();
  });

  it('places the window at a message, with its position and a bounded stretch around it', () => {
    const { db, ids } = thread();
    for (const at of [0, 1, 5, 6, 11]) {
      const w = cards(db, [ids[0]!], { rowid: ids[at]!, index: 0 });
      expect(w.anchor).toBe(at);
      expect(w.anchorFound).toBe(true);
      expect(w.start).toBe(Math.max(0, at - 3));
      expect(w.cards.map((c) => c.rowid)).toEqual(ids.slice(Math.max(0, at - 3), at + 4));
    }
    db.close();
  });

  it('takes the nearest card, newer first, for a removed message, then the position', () => {
    const { db, ids } = thread();
    const key = { time: 108, rowid: ids[8]! };
    db.exec(`DELETE FROM messages WHERE rowid = ${ids[8]!}`);
    const next = cards(db, [ids[8]!, ids[0]!], { rowid: ids[8]!, key, index: 0 });
    expect(next.total).toBe(11);
    expect(next.anchorFound).toBe(false);
    expect(next.cards[next.anchor! - next.start]!.rowid).toBe(ids[9]);
    // The newest removed: the one before it takes its place.
    const last = { time: 111, rowid: ids[11]! };
    db.exec(`DELETE FROM messages WHERE rowid = ${ids[11]!}`);
    const older = cards(db, [ids[0]!], { rowid: ids[11]!, key: last, index: 0 });
    expect(older.cards[older.anchor! - older.start]!.rowid).toBe(ids[10]);
    // No message and no key: the position.
    const byIndex = cards(db, [ids[0]!], { index: 4 });
    expect(byIndex.anchorFound).toBe(false);
    expect(byIndex.cards[byIndex.anchor! - byIndex.start]!.rowid).toBe(ids[4]);
    expect(cards(db, [ids[0]!], { index: 500 }).anchor).toBe(9);
    db.close();
  });

  it('follows the first message still there, then the conversation, then shows nothing', () => {
    const { db, ids } = thread();
    const threadId = threadOf(db, 't0');
    const other = rowidOf(db, 'other');
    // A message that is gone is skipped; the next one names the conversation.
    expect(cards(db, [999_999, other, ids[2]!], { index: 0 })).toMatchObject({
      total: 1,
      followed: other,
    });
    expect(cards(db, [999_999, ids[2]!], { index: 0 })).toMatchObject({
      total: 12,
      followed: ids[2],
    });
    // None left: the conversation itself, while it has messages.
    expect(cards(db, [999_999], { index: 0 }, 3, 4, threadId)).toMatchObject({
      total: 12,
      threadId,
      followed: null,
    });
    db.exec(`DELETE FROM messages WHERE thread_id = ${threadId}`);
    expect(cards(db, [ids[2]!], { rowid: ids[2]!, index: 0 }, 3, 4, threadId)).toEqual({
      threadId: null,
      followed: null,
      subject: '',
      total: 0,
      labelIds: [],
      start: 0,
      cards: [],
      anchor: null,
      anchorFound: false,
    });
    db.close();
  });

  it('follows a message into the conversation it was merged into', () => {
    const { db, writer, ids } = thread();
    const other = rowidOf(db, 'other');
    // A message that links both conversations merges them.
    ingest(writer, [message('link', ['link', 't0', 'other'], { time: 200 })], 1);
    const w = cards(db, [other], { rowid: other, index: 0 }, 50, 50);
    expect(w.total).toBe(14);
    expect(w.anchorFound).toBe(true);
    expect(w.cards[0]!.rowid).toBe(other);
    expect(w.cards.map((c) => c.rowid)).toEqual(expect.arrayContaining(ids));
    db.close();
  });

  it('gives the conversation’s folder and label IDs, the same as its list row’s, also after a merge', () => {
    const { db, writer, ids } = thread();
    const threadId = threadOf(db, 't0');
    const w = cards(db, [ids[4]!], { rowid: ids[4]!, index: 0 });
    expect(w.labelIds).toEqual(['0', '2', '3', '4', '5', '7']);
    expect(w.labelIds).toEqual(rowDetails(db, [threadId])[0]!.labelIds);
    // Merged with a conversation that has a label of its own.
    ingest(writer, [message('tagged', ['tagged'], { time: 60, labelIds: ['0', '5', 'lab1'] })], 1);
    ingest(writer, [message('link', ['link', 't0', 'tagged'], { time: 200 })], 1);
    const tagged = rowidOf(db, 'tagged');
    const merged = cards(db, [tagged], { rowid: tagged, index: 0 });
    expect(merged.threadId).toBe(threadOf(db, 'tagged'));
    expect(merged.labelIds).toContain('lab1');
    expect(merged.labelIds).toEqual(rowDetails(db, [merged.threadId!])[0]!.labelIds);
    db.close();
  });

  it('caps how many cards it reads around the anchor', () => {
    const { db, writer } = fresh();
    const rows = Array.from({ length: 400 }, (_, i) =>
      message(`b${i}`, i === 0 ? ['b0'] : [`b${i}`, 'b0'], { time: 1000 + i }),
    );
    ingest(writer, rows, 100);
    const mid = rowidOf(db, 'b200');
    const w = cards(db, [mid], { rowid: mid, index: 0 }, 10_000, 10_000);
    expect(w.total).toBe(400);
    expect(w.cards).toHaveLength(CARDS_BEFORE + CARDS_AFTER);
    expect(w.start).toBe(200 - CARDS_BEFORE);
    expect(w.anchor).toBe(200);
    // At least one card from the anchor on.
    expect(cards(db, [mid], { rowid: mid, index: 0 }, 0, 0).cards.map((c) => c.rowid)).toEqual([
      mid,
    ]);
    db.close();
  });
});
