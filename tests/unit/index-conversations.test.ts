// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { parseMetadata, type MessageRow } from '../../src/core/index/metadata';
import { asNumber } from '../../src/core/index/sql';
import {
  STAMP,
  checkAgainstScratch,
  expected,
  fresh,
  ingest,
  item,
  keysOf,
  message,
  newPair,
  partition,
  shuffled,
} from '../index-helpers';

/** A metadata file's text with the given header block. */
function metadata(id: string, headers: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    Version: 1,
    Payload: {
      ID: id,
      LabelIDs: ['5'],
      ExternalID: '',
      Subject: 'Same subject',
      Sender: { Name: 'A', Address: 'a@example.com' },
      Time: 100,
      Headers: headers,
      ...extra,
    },
  });
}

const row = (id: string, headers: string, extra?: Record<string, unknown>) =>
  parseMetadata(id, metadata(id, headers, extra));

/** Writes the rows one batch at a time and checks against a from-scratch grouping after each. */
function groupChecked(rows: MessageRow[], batch = 1): string[][] {
  const { db, writer } = fresh();
  ingest(writer, rows, batch, (written) => checkAgainstScratch(db, written));
  const result = partition(db);
  db.close();
  return result;
}

describe('conversation keys from the metadata headers', () => {
  it('groups a reply chain through References', () => {
    const rows = [
      row('a', 'Message-ID: <a@x>\r\n'),
      row('b', 'Message-ID: <b@x>\r\nReferences: <a@x>\r\n'),
      row('c', 'Message-ID: <c@x>\r\nReferences: <a@x> <b@x>\r\n'),
    ];
    expect(groupChecked(rows)).toEqual([['a', 'b', 'c']]);
  });

  it('groups through In-Reply-To alone', () => {
    const rows = [
      row('a', 'Message-ID: <a@x>\r\n'),
      row('b', 'Message-ID: <b@x>\r\nIn-Reply-To: <a@x>\r\n'),
    ];
    expect(groupChecked(rows)).toEqual([['a', 'b']]);
  });

  it('takes only the msg-id from a phrase-form In-Reply-To', () => {
    const rows = [
      row('a', 'Message-ID: <a@x>\r\n'),
      row('b', 'Message-ID: <b@x>\r\nIn-Reply-To: Your message of Monday <a@x>\r\n'),
      // Words of the phrase never become keys.
      row('c', 'Message-ID: <Your>\r\n'),
      row('d', 'Message-ID: <d@x>\r\nIn-Reply-To: Your message of Monday\r\n'),
    ];
    expect(keysOf(rows[1]!)).toEqual(['b@x', 'a@x']);
    expect(groupChecked(rows)).toEqual([['a', 'b'], ['c'], ['d']]);
  });

  it('links nothing through an empty <>', () => {
    const rows = [
      row('a', 'Message-ID: <a@x>\r\nIn-Reply-To: <>\r\n'),
      row('b', 'Message-ID: <b@x>\r\nIn-Reply-To: <>\r\nReferences: <> < >\r\n'),
    ];
    expect(keysOf(rows[1]!)).toEqual(['b@x']);
    expect(groupChecked(rows)).toEqual([['a'], ['b']]);
  });

  it('groups across a missing middle message through References', () => {
    // b is missing from the export; c still names a in its References.
    const rows = [
      row('a', 'Message-ID: <a@x>\r\n'),
      row('c', 'Message-ID: <c@x>\r\nIn-Reply-To: <b@x>\r\nReferences: <a@x> <b@x>\r\n'),
    ];
    expect(groupChecked(rows)).toEqual([['a', 'c']]);
  });

  it('joins copies with the same Message-ID and keeps each one', () => {
    const rows = [row('sent', 'Message-ID: <same@x>\r\n'), row('got', 'Message-ID: <same@x>\r\n')];
    expect(groupChecked(rows)).toEqual([['got', 'sent']]);
  });

  it('handles a References cycle', () => {
    const rows = [
      row('a', 'Message-ID: <a@x>\r\nReferences: <b@x>\r\n'),
      row('b', 'Message-ID: <b@x>\r\nReferences: <a@x>\r\n'),
    ];
    expect(groupChecked(rows)).toEqual([['a', 'b']]);
  });

  it('uses only the last 100 References', () => {
    const refs = Array.from({ length: 150 }, (_, i) => `<r${i}@x>`).join(' ');
    const long = row('long', `Message-ID: <long@x>\r\nReferences: ${refs}\r\n`);
    expect(keysOf(long)).toHaveLength(101);
    expect(keysOf(long)).not.toContain('r49@x');
    expect(keysOf(long)).toContain('r50@x');
    const rows = [
      long,
      row('early', 'Message-ID: <r10@x>\r\n'),
      row('late', 'Message-ID: <r120@x>\r\n'),
    ];
    expect(groupChecked(rows)).toEqual([['early'], ['late', 'long']]);
  });

  it('falls back to ExternalID, and with neither the message stands alone', () => {
    const rows = [
      row('a', '', { ExternalID: 'ext-1@x' }),
      row('b', 'In-Reply-To: <ext-1@x>\r\n'),
      row('c', ''),
      row('d', ''),
    ];
    expect(rows[0]!.messageId).toBe('ext-1@x');
    expect(keysOf(rows[2]!)).toEqual([]);
    expect(groupChecked(rows)).toEqual([['a', 'b'], ['c'], ['d']]);
  });

  it('keeps the same subject without shared IDs apart', () => {
    const rows = [row('a', 'Message-ID: <a@x>\r\n'), row('b', 'Message-ID: <b@x>\r\n')];
    expect(rows[0]!.subject).toBe(rows[1]!.subject);
    expect(groupChecked(rows)).toEqual([['a'], ['b']]);
  });

  it('takes the DMARC result and unfolds headers', () => {
    const r = row(
      'a',
      'Message-ID:\r\n <a@x>\r\nAuthentication-Results: mx; spf=pass;\r\n dmarc=FAIL header.from=x\r\n',
    );
    expect(r.messageId).toBe('a@x');
    expect(r.dmarc).toBe('fail');
  });
});

describe('merges and counts', () => {
  it('merges when a linking message arrives in a later batch', () => {
    const rows = [
      message('a', ['a']),
      message('b', ['b']),
      message('c', ['c']),
      message('link', ['link', 'a', 'b']),
    ];
    const { db, writer } = fresh();
    const stats = ingest(writer, rows, 3, (written) => checkAgainstScratch(db, written));
    expect(partition(db)).toEqual([['a', 'b', 'link'], ['c']]);
    expect(stats[1]!.merges).toBe(1);
    db.close();
  });

  it('keeps conversation, folder and unread counts right through a merge', () => {
    const { db, writer } = fresh();
    ingest(
      writer,
      [
        message('x1', ['x1'], { unread: 1, labelIds: ['0', '5'], time: 10 }),
        message('y1', ['y1'], { unread: 1, labelIds: ['5', 'L'], time: 30, numAttachments: 2 }),
        message('xy', ['xy', 'x1', 'y1'], { unread: 0, labelIds: ['5'], time: 20 }),
      ],
      1,
    );
    const t = db.stmt('SELECT * FROM threads').all();
    expect(t).toHaveLength(1);
    expect(asNumber(t[0]!.msg_count)).toBe(3);
    expect(asNumber(t[0]!.unread_count)).toBe(2);
    expect(asNumber(t[0]!.attach_count)).toBe(1);
    expect(asNumber(t[0]!.first_time)).toBe(10);
    expect(asNumber(t[0]!.last_time)).toBe(30);
    const labels = Object.fromEntries(
      db
        .stmt('SELECT label_id, msg_count, unread_count, last_time FROM thread_labels')
        .all()
        .map((r) => [
          String(r.label_id),
          [asNumber(r.msg_count), asNumber(r.unread_count), asNumber(r.last_time)],
        ]),
    );
    expect(labels).toEqual({ '0': [1, 1, 10], '5': [3, 2, 30], L: [1, 1, 30] });
    db.close();
  });

  it('gives the same partition for any read order, checked after every batch', () => {
    const chain = Array.from({ length: 120 }, (_, i) =>
      message(`c${String(i).padStart(4, '0')}`, i === 0 ? ['k0'] : [`k${i}`, `k${i - 1}`], {
        time: i,
        unread: i % 3 === 0 ? 1 : 0,
        labelIds: i % 2 ? ['5', '0'] : ['5', 'L1'],
        numAttachments: i % 5 === 0 ? 1 : 0,
      }),
    );
    const star = Array.from({ length: 30 }, (_, i) =>
      message(`s${i}`, [`s${i}`, 'hub'], { time: 500 + i, labelIds: ['5', '7'] }),
    );
    const singles = Array.from({ length: 15 }, (_, i) => message(`u${i}`, [`u${i}`]));
    const noKeys = [message('n1', []), message('n2', [])];
    const all = [...chain, ...star, ...singles, ...noKeys];
    const want = expected(all);
    for (const seed of [1, 2, 3, 4]) {
      const { db, writer } = fresh();
      ingest(writer, shuffled(all, seed), 17, (written) => checkAgainstScratch(db, written));
      expect(partition(db)).toEqual(want);
      db.close();
    }
  });

  it('re-points only the smaller side when the larger one has the higher ID', () => {
    const { db, writer } = fresh();
    // The small conversation is made first, so it has the lower ID.
    const small = Array.from({ length: 5 }, (_, i) =>
      message(`a${i}`, [`a${i}`, 'small-root'], { labelIds: ['5', 'S'] }),
    );
    const large = Array.from({ length: 1200 }, (_, i) =>
      message(`b${i}`, [`b${i}`, 'large-root'], { labelIds: ['5', 'B'] }),
    );
    ingest(writer, small, 1000);
    ingest(writer, large, 1000);
    const ids = db
      .stmt('SELECT thread_id, msg_count FROM threads ORDER BY thread_id')
      .all()
      .map((r) => [asNumber(r.thread_id), asNumber(r.msg_count)]);
    expect(ids.map((r) => r[1])).toEqual([5, 1200]);
    const [link] = ingest(writer, [message('z', ['z', 'small-root', 'large-root'])], 1000);
    expect(link!.merges).toBe(1);
    // Members, keys and per-label rows of the five-message side only.
    expect(link!.repointedMessages).toBe(5);
    expect(link!.repointedKeys).toBe(6);
    expect(link!.repointedLabelRows).toBe(2);
    expect(link!.maxRepointed).toBe(13);
    const survivor = db.stmt('SELECT thread_id FROM threads').all();
    expect(survivor.map((r) => asNumber(r.thread_id))).toEqual([ids[1]![0]]);
    checkAgainstScratch(db, [...small, ...large, message('z', ['z', 'small-root', 'large-root'])]);
    db.close();
  });

  it('changes no conversation for a late result of a pair already written', () => {
    const { db, writer } = fresh();
    ingest(writer, [message('a', ['a']), message('b', ['b'])], 10);
    const before = partition(db);
    // A late copy of b's result, for the rev it was written for, that would link it to a.
    const rev = asNumber(db.stmt("SELECT rev FROM pairs WHERE proton_id = 'b'").get()?.rev);
    const stats = writer.phase1Batch(STAMP, [item(message('b', ['b', 'a']), rev)]);
    expect(stats).toMatchObject({ dropped: 1, messages: 0, merges: 0 });
    expect(partition(db)).toEqual(before);
    db.close();
  });

  it('writes nothing for a batch from another generation', () => {
    const { db, writer } = fresh();
    const other = { ...STAMP, generation: STAMP.generation + 1 };
    expect(writer.applyChanges(other, [newPair('a')]).stale).toBe(true);
    const stats = writer.phase1Batch(other, [item(message('a', ['a']), 1)]);
    expect(stats.stale).toBe(true);
    expect(asNumber(db.stmt('SELECT count(*) AS n FROM pairs').get()?.n)).toBe(0);
    db.close();
  });

  it('gives every pair a new rev from the sequence', () => {
    const { db, writer } = fresh();
    ingest(writer, [message('a', ['a']), message('b', ['b'])], 1);
    ingest(writer, [message('c', ['c'])], 1);
    const revs = db
      .stmt('SELECT rev FROM pairs ORDER BY rev')
      .all()
      .map((r) => asNumber(r.rev));
    expect(revs).toEqual([1, 2, 3]);
    expect(
      asNumber(db.stmt("SELECT value FROM source_meta WHERE key = 'rev_seq'").get()?.value),
    ).toBe(3);
    db.close();
  });
});
