// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { MessageRow } from '../../src/testhooks/bench/metadata';
import { createSchema } from '../../src/testhooks/bench/schema';
import { asNumber, openDb, type Db } from '../../src/testhooks/bench/sql';
import { IndexWriter, type Phase1Item, type Phase1Stats } from '../../src/testhooks/bench/writer';

function message(id: string, keys: string[], extra: Partial<MessageRow> = {}): MessageRow {
  return {
    protonId: id,
    time: 1000,
    subject: id,
    sender: { name: id, address: `${id}@example.com` },
    to: [],
    cc: [],
    bcc: [],
    replyTo: [],
    flags: 0,
    unread: 0,
    replied: 0,
    repliedAll: 0,
    forwarded: 0,
    size: 1,
    numAttachments: 0,
    mimeType: 'text/plain',
    messageId: keys[0] ?? null,
    inReplyTo: null,
    references: [],
    dmarc: null,
    labelIds: ['5'],
    keys,
    attachments: [],
    ...extra,
  };
}

function item(row: MessageRow): Phase1Item {
  return {
    pair: {
      protonId: row.protonId,
      metaRel: `${row.protonId}.metadata.json`,
      metaSize: 1,
      metaMtimeNs: 0,
      metaDev: 0,
      metaIno: 0,
      emlRel: `${row.protonId}.eml`,
      emlSize: 1,
      emlMtimeNs: 0,
      emlDev: 0,
      emlIno: 0,
    },
    row,
    error: null,
  };
}

function fresh(): { db: Db; writer: IndexWriter } {
  const db = openDb(':memory:', { engine: 'node:sqlite' });
  createSchema(db);
  return { db, writer: new IndexWriter(db) };
}

/** The partition as sorted member lists, independent of conversation IDs. */
function partition(db: Db): string[][] {
  const groups = new Map<number, string[]>();
  for (const r of db.stmt('SELECT proton_id, thread_id FROM messages').all()) {
    const t = asNumber(r.thread_id);
    groups.set(t, [...(groups.get(t) ?? []), String(r.proton_id)]);
  }
  return [...groups.values()].map((g) => g.sort()).sort((a, b) => (a[0]! < b[0]! ? -1 : 1));
}

/** Grouping from scratch: union-find over shared keys. */
function expected(rows: MessageRow[]): string[][] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    while (parent.get(x) !== x) x = parent.get(x)!;
    return x;
  };
  const owner = new Map<string, string>();
  for (const r of rows) parent.set(r.protonId, r.protonId);
  for (const r of rows)
    for (const k of r.keys) {
      const o = owner.get(k);
      if (o === undefined) owner.set(k, r.protonId);
      else parent.set(find(r.protonId), find(o));
    }
  const groups = new Map<string, string[]>();
  for (const r of rows)
    groups.set(find(r.protonId), [...(groups.get(find(r.protonId)) ?? []), r.protonId]);
  return [...groups.values()].map((g) => g.sort()).sort((a, b) => (a[0]! < b[0]! ? -1 : 1));
}

function shuffled<T>(list: T[], seed: number): T[] {
  const out = [...list];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function ingest(writer: IndexWriter, rows: MessageRow[], batch: number): Phase1Stats[] {
  const stats: Phase1Stats[] = [];
  for (let i = 0; i < rows.length; i += batch)
    stats.push(writer.phase1Batch(rows.slice(i, i + batch).map(item)));
  return stats;
}

describe('phase 1 conversation grouping', () => {
  it('groups an In-Reply-To-only chain the same for any read order', () => {
    const chain = Array.from({ length: 300 }, (_, i) =>
      message(`c${String(i).padStart(4, '0')}`, i === 0 ? ['k0'] : [`k${i}`, `k${i - 1}`]),
    );
    const singles = Array.from({ length: 20 }, (_, i) => message(`s${i}`, [`solo${i}`]));
    const noKeys = [message('n1', []), message('n2', [])];
    const all = [...chain, ...singles, ...noKeys];
    for (const seed of [1, 2, 3]) {
      const { db, writer } = fresh();
      ingest(writer, shuffled(all, seed), 37);
      expect(partition(db)).toEqual(expected(all));
      const threads = db.stmt('SELECT count(*) AS n, sum(msg_count) AS m FROM threads').get()!;
      expect(asNumber(threads.n)).toBe(1 + 20 + 2);
      expect(asNumber(threads.m)).toBe(all.length);
      db.close();
    }
  });

  it('merges a late link into the larger side, re-pointing only the smaller one', () => {
    const { db, writer } = fresh();
    const small = Array.from({ length: 5 }, (_, i) => message(`a${i}`, [`a${i}`, 'small-root']));
    const large = Array.from({ length: 600 }, (_, i) => message(`b${i}`, [`b${i}`, 'large-root']));
    ingest(writer, small, 1000);
    ingest(writer, large, 1000);
    const [link] = ingest(writer, [message('z', ['z', 'small-root', 'large-root'])], 1000);
    expect(link!.merges).toBe(1);
    expect(link!.repointedMessages).toBe(5);
    const [merge] = link!.bigMerges;
    expect(merge).toMatchObject({ intoSize: 600, fromSize: 5, repointed: 5 });
    expect(merge!.into).toBeGreaterThan(merge!.from);
    expect(partition(db)).toHaveLength(1);
    const t = db.stmt('SELECT msg_count FROM threads').all();
    expect(t.map((r) => asNumber(r.msg_count))).toEqual([606]);
    db.close();
  });

  it('keeps conversation and per-label counts right through a merge', () => {
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

  it('joins copies with the same Message-ID and keeps each one', () => {
    const { db, writer } = fresh();
    ingest(writer, [message('sent', ['same@x']), message('received', ['same@x'])], 10);
    expect(partition(db)).toEqual([['received', 'sent']]);
    db.close();
  });

  it('drops a body result whose rev no longer matches its pair', () => {
    const { db, writer } = fresh();
    ingest(writer, [message('m1', ['m1'])], 10);
    const rev = writer.revOf('m1')!;
    const stale = writer.phase2Batch([
      { protonId: 'm1', rev: rev + 1, state: 1, text: 'old', error: null },
    ]);
    expect(stale).toMatchObject({ written: 0, dropped: 1 });
    const gone = writer.phase2Batch([
      { protonId: 'missing', rev, state: 1, text: 'x', error: null },
    ]);
    expect(gone).toMatchObject({ written: 0, dropped: 1 });
    const ok = writer.phase2Batch([
      { protonId: 'm1', rev, state: 1, text: 'hello world', error: null },
    ]);
    expect(ok).toMatchObject({ written: 1, dropped: 0 });
    const hit = db.stmt("SELECT rowid FROM fts WHERE fts MATCH 'hello'").all();
    expect(hit).toHaveLength(1);
    db.close();
  });
});
