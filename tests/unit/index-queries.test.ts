// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  PARTICIPANT_SCAN,
  listPage,
  rowDetails,
  threadOfMessage,
} from '../../src/core/index/queries';
import { asNumber } from '../../src/core/index/sql';
import { fresh, ingest, message } from '../index-helpers';

describe('conversation list pages', () => {
  it('pages newest first with a keyset on date and conversation, ties included', () => {
    const { db, writer } = fresh();
    const rows = Array.from({ length: 25 }, (_, i) =>
      message(`m${i}`, [`m${i}`], { time: 100 + Math.floor(i / 5), labelIds: ['5'] }),
    );
    ingest(writer, rows, 7);
    const seen: number[] = [];
    let after = null;
    for (;;) {
      const page = listPage(db, '5', after, 4);
      for (const r of page.rows) seen.push(r.threadId);
      if (!page.next) break;
      after = page.next;
    }
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    const all = listPage(db, '5', null, 200).rows;
    for (let i = 1; i < all.length; i++) {
      const a = all[i - 1]!;
      const b = all[i]!;
      expect(a.time > b.time || (a.time === b.time && a.threadId > b.threadId)).toBe(true);
    }
    expect(seen).toEqual(all.map((r) => r.threadId));
    db.close();
  });

  it("shows a conversation's latest date in this folder, counts and markers", () => {
    const { db, writer } = fresh();
    ingest(
      writer,
      [
        message('in', ['k1'], { time: 10, labelIds: ['0', '5'], unread: 1 }),
        message('sent', ['k2', 'k1'], { time: 50, labelIds: ['7', '5'], numAttachments: 3 }),
        message('other', ['o'], { time: 20, labelIds: ['0', '5'] }),
      ],
      1,
    );
    const inbox = listPage(db, '0', null).rows;
    expect(inbox.map((r) => [r.time, r.count, r.unread, r.unreadHere, r.attachments])).toEqual([
      [20, 1, 0, 0, false],
      [10, 2, 1, 1, true],
    ]);
    const inRowid = asNumber(
      db.stmt("SELECT rowid FROM messages WHERE proton_id = 'in'").get()?.rowid,
    );
    expect(inbox[1]!.anchorRowid).toBe(inRowid);
    // Its newest message of all is the sent reply, outside the inbox.
    const sentRowid = asNumber(
      db.stmt("SELECT rowid FROM messages WHERE proton_id = 'sent'").get()?.rowid,
    );
    expect(inbox[1]!.newestRowid).toBe(sentRowid);
    expect(inbox[0]!.newestRowid).toBe(inbox[0]!.anchorRowid);
    const sent = listPage(db, '7', null).rows;
    expect(sent.map((r) => r.time)).toEqual([50]);
    expect(sent[0]!.newestRowid).toBe(sentRowid);
    db.close();
  });

  it('holds the rows written so far while more batches arrive', () => {
    const { db, writer } = fresh();
    const rows = Array.from({ length: 30 }, (_, i) => message(`m${i}`, [`m${i}`], { time: i }));
    ingest(writer, rows.slice(0, 10), 10);
    expect(listPage(db, '5', null).rows.map((r) => r.time)).toEqual(
      Array.from({ length: 10 }, (_, i) => 9 - i),
    );
    ingest(writer, rows.slice(10), 10);
    expect(listPage(db, '5', null).rows).toHaveLength(30);
    db.close();
  });
});

describe('rows on screen', () => {
  it('reads the earliest subject and up to four distinct senders, oldest first', () => {
    const { db, writer } = fresh();
    const senders = ['ann', 'bob', 'ann', 'cy', 'dee', 'eve'];
    ingest(
      writer,
      senders.map((s, i) =>
        message(`m${i}`, [`m${i}`, 'root'], {
          time: 100 + i,
          subject: `Subject ${i}`,
          sender: { name: s.toUpperCase(), address: `${s}@example.com` },
        }),
      ),
      10,
    );
    const thread = asNumber(db.stmt('SELECT thread_id FROM threads').get()?.thread_id);
    const [d] = rowDetails(db, [thread]);
    expect(d!.subject).toBe('Subject 0');
    expect(d!.participants.map((p) => p.address)).toEqual([
      'ann@example.com',
      'bob@example.com',
      'cy@example.com',
      'dee@example.com',
    ]);
    expect(d!.labelIds).toEqual(['5']);
    db.close();
  });

  it(`takes participants from the first ${PARTICIPANT_SCAN} messages only`, () => {
    const { db, writer } = fresh();
    const rows = Array.from({ length: PARTICIPANT_SCAN + 10 }, (_, i) =>
      message(`m${i}`, [`m${i}`, 'root'], {
        time: i,
        sender:
          i < PARTICIPANT_SCAN
            ? { name: 'Same', address: 'same@example.com' }
            : { name: `Late ${i}`, address: `late${i}@example.com` },
      }),
    );
    ingest(writer, rows, 1000);
    const thread = asNumber(db.stmt('SELECT thread_id FROM threads').get()?.thread_id);
    expect(rowDetails(db, [thread])[0]!.participants).toEqual([
      { name: 'Same', address: 'same@example.com' },
    ]);
    db.close();
  });

  it('re-resolves a selection through the message rowid after a merge', () => {
    const { db, writer } = fresh();
    ingest(
      writer,
      [message('big1', ['b1', 'B']), message('big2', ['b2', 'B']), message('small', ['s'])],
      10,
    );
    const rowid = asNumber(
      db.stmt("SELECT rowid FROM messages WHERE proton_id = 'small'").get()?.rowid,
    );
    const before = threadOfMessage(db, rowid);
    ingest(writer, [message('link', ['l', 's', 'B'])], 10);
    const after = threadOfMessage(db, rowid);
    expect(after).not.toBe(before);
    // The old conversation is gone; the rowid leads to the one that took it in.
    expect(db.stmt('SELECT 1 FROM threads WHERE thread_id = ?').get(before)).toBeUndefined();
    expect(
      asNumber(db.stmt('SELECT msg_count FROM threads WHERE thread_id = ?').get(after)?.msg_count),
    ).toBe(4);
    expect(threadOfMessage(db, 99_999)).toBeNull();
    db.close();
  });
});
