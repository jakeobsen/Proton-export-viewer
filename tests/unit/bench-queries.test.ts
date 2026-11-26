// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { MessageRow } from '../../src/testhooks/bench/metadata';
import {
  PAGE_SIZE,
  ftsLiteral,
  listPage,
  markedToRanges,
  searchByDate,
  searchByRelevance,
  type DateKey,
  type RankKey,
} from '../../src/testhooks/bench/queries';
import { createSchema } from '../../src/testhooks/bench/schema';
import { asNumber, openDb, type Db } from '../../src/testhooks/bench/sql';
import { IndexWriter } from '../../src/testhooks/bench/writer';

function row(id: string, keys: string[], time: number, subject: string): MessageRow {
  return {
    protonId: id,
    time,
    subject,
    sender: { name: `S ${id}`, address: `${id}@example.com` },
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
  };
}

/**
 * 450 conversations whose subject matches, one of them with 300 matching
 * messages, so its messages straddle every page boundary; plus non-matching mail.
 */
function build(): Db {
  const db = openDb(':memory:', { engine: 'node:sqlite' });
  createSchema(db);
  const writer = new IndexWriter(db);
  const rows: MessageRow[] = [];
  for (let c = 0; c < 450; c++)
    rows.push(row(`c${c}`, [`c${c}`], 1000 + ((c * 7919) % 450), 'quarterly report'));
  for (let m = 0; m < 300; m++)
    rows.push(row(`big${m}`, [`big${m}`, 'c17'], 500 + m * 3, 'report again'));
  for (let o = 0; o < 100; o++) rows.push(row(`o${o}`, [`o${o}`], 2000 + o, 'unrelated'));
  for (let i = 0; i < rows.length; i += 128)
    writer.phase1Batch(
      rows.slice(i, i + 128).map((r) => ({
        pair: {
          protonId: r.protonId,
          metaRel: 'm',
          metaSize: 1,
          metaMtimeNs: 0,
          metaDev: 0,
          metaIno: 0,
          emlRel: 'e',
          emlSize: 1,
          emlMtimeNs: 0,
          emlDev: 0,
          emlIno: 0,
        },
        row: r,
        error: null,
      })),
    );
  return db;
}

function pages<K>(fetch: (after: K | null) => { rows: { threadId: number }[]; next: K | null }) {
  const all: number[][] = [];
  let after: K | null = null;
  do {
    const page = fetch(after);
    all.push(page.rows.map((r) => r.threadId));
    after = page.next;
  } while (after !== null);
  return all;
}

describe('grouped search pagination', () => {
  const db = build();
  const term = ftsLiteral('report');
  const matching = asNumber(
    db
      .stmt(
        'SELECT count(DISTINCT m.thread_id) AS n FROM fts JOIN messages m ON m.rowid = fts.rowid WHERE fts MATCH ?',
      )
      .get(term)!.n,
  );

  it('pages by date with full pages, no duplicates and no omissions', () => {
    const p = pages<DateKey>((after) => searchByDate(db, term, after));
    expect(matching).toBe(450);
    expect(p.slice(0, -1).every((ids) => ids.length === PAGE_SIZE)).toBe(true);
    const ids = p.flat();
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(matching);
  });

  it('pages by relevance with full pages, no duplicates and no omissions', () => {
    const p = pages<RankKey>((after) => searchByRelevance(db, term, after));
    expect(p.slice(0, -1).every((ids) => ids.length === PAGE_SIZE)).toBe(true);
    const ids = p.flat();
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(matching);
  });

  it('shows the big conversation once, with its matching count and a snippet', () => {
    const first = searchByDate(db, term, null);
    const big = asNumber(
      db.stmt("SELECT thread_id FROM messages WHERE proton_id = 'big0'").get()!.thread_id,
    );
    const hit = [...first.rows, ...searchByDate(db, term, first.next).rows].find(
      (r) => r.threadId === big,
    );
    expect(hit?.matching).toBe(301);
    const visible = first.rows.find((r) => r.snippet);
    expect(visible?.snippet?.ranges.length).toBeGreaterThan(0);
  });

  it('lists conversations newest first with subjects for visible rows', () => {
    const p = pages<DateKey>((after) => listPage(db, '5', after));
    expect(p.flat()).toHaveLength(450 + 100);
    const first = listPage(db, '5', null).rows[0]!;
    expect(first.subject).toBe('unrelated');
    expect(first.participants).toEqual(['S o99']);
  });

  it('folds diacritics and treats operators in a term as text', () => {
    const d = openDb(':memory:', { engine: 'node:sqlite' });
    createSchema(d);
    d.exec(
      "INSERT INTO message_text(rowid, subject, sender, recipients, body, attachments) VALUES (1, 'Héllo', '', '', 'x', '')",
    );
    expect(d.stmt('SELECT rowid FROM fts WHERE fts MATCH ?').all(ftsLiteral('hello'))).toHaveLength(
      1,
    );
    expect(
      d.stmt('SELECT rowid FROM fts WHERE fts MATCH ?').all(ftsLiteral('NOT OR "x')),
    ).toHaveLength(0);
    d.close();
  });
});

describe('markedToRanges', () => {
  it('gives UTF-16 ranges that never split a surrogate pair', () => {
    const r = markedToRanges('a 😀b ç 日本');
    expect(r.text).toBe('a 😀b ç 日本');
    expect(r.ranges).toEqual([
      [2, 5],
      [8, 10],
    ]);
    for (const [s, e] of r.ranges) {
      expect(r.text.charCodeAt(s) & 0xfc00).not.toBe(0xdc00);
      expect(e).toBeLessThanOrEqual(r.text.length);
    }
  });

  it('drops empty and unclosed marks safely', () => {
    expect(markedToRanges('xy').ranges).toEqual([[1, 2]]);
  });
});
