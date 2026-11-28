// SPDX-License-Identifier: AGPL-3.0-or-later
// Lead lines and the cards of a conversation opened from a search: each
// message's first words, cleaned for one line and cut without splitting a
// character; the search's snippet on the messages that match it; which cards
// match and how many messages of the conversation do, from one snapshot; and
// the revision of that snapshot.

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEAD_READ, leadText, leads } from '../../src/core/index/leads';
import { QueryState, WriterState } from '../../src/core/index/ops';
import { BODY_STATE } from '../../src/core/index/schema';
import { cardsAnswer, matchedSnippets, searchPage } from '../../src/core/index/search';
import { asNumber, configure, openDb, type Db } from '../../src/core/index/sql';
import { localDay } from '../../src/core/search/query';
import { validRanges } from '../../src/core/search/ranges';
import {
  LEAD_UNITS,
  MAX_LEAD_ROWIDS,
  type CardsQuery,
  type CardsWindow,
  type LeadsAnswer,
} from '../../src/shared/index-types';
import type { Chip } from '../../src/shared/search-chips';
import { STAMP, fresh, ingest, item, message, newPair } from '../index-helpers';
import { testDir } from '../paths';

const rowidOf = (db: Db, protonId: string) =>
  asNumber(db.stmt('SELECT rowid FROM messages WHERE proton_id = ?').get(protonId)?.rowid);
const threadOf = (db: Db, protonId: string) =>
  asNumber(db.stmt('SELECT thread_id FROM messages WHERE proton_id = ?').get(protonId)?.thread_id);

/** Gives a message its body, as phase 2 would. */
function setBody(db: Db, protonId: string, body: string, state: number = BODY_STATE.indexed) {
  db.stmt('UPDATE message_text SET body = ? WHERE rowid = ?').run(body, rowidOf(db, protonId));
  db.stmt('UPDATE pairs SET body_state = ? WHERE proton_id = ?').run(state, protonId);
}

/** Noon of a local day, in seconds. */
const day = (date: string) => localDay(date)! + 12 * 3600;

/**
 * One conversation of four messages (c1 oldest, c4 newest, a month apart)
 * from Lee and Kim, and a one-message conversation, each with a body.
 */
function thread(): { db: Db; ids: number[] } {
  const { db, writer } = fresh();
  const lee = { name: 'Lee', address: 'lee@example.com' };
  const kim = { name: 'Kim', address: 'kim@example.com' };
  ingest(
    writer,
    [
      message('c1', ['c1'], { time: day('2026-01-10'), subject: 'Studio', sender: lee }),
      message('c2', ['c2', 'c1'], { time: day('2026-02-10'), subject: 'Re: Studio', sender: kim }),
      message('c3', ['c3', 'c1'], { time: day('2026-03-10'), subject: 'Re: Studio', sender: lee }),
      message('c4', ['c4', 'c1'], { time: day('2026-04-10'), subject: 'Re: Studio', sender: kim }),
      message('o1', ['o1'], { time: day('2025-12-01'), subject: 'Lunch', sender: kim }),
    ],
    5,
  );
  setBody(db, 'c1', 'Attached is the invoice for the studio session.');
  setBody(db, 'c2', 'Thanks, could you add the address to it?');
  setBody(db, 'c3', 'Here is the updated invoice with the address.');
  setBody(db, 'c4', 'Perfect, paid today.');
  setBody(db, 'o1', 'Lunch on Friday? The invoice can wait.');
  return { db, ids: ['c1', 'c2', 'c3', 'c4'].map((id) => rowidOf(db, id)) };
}

const cardsQuery = (
  db: Db,
  rowid: number,
  search?: { text: string; chips?: Chip[]; countRev: number | null },
  before = 100,
  after = 200,
): CardsQuery => ({
  op: 'cards',
  follow: [rowid],
  threadId: threadOf(db, 'c1'),
  anchor: { rowid, index: 0 },
  before,
  after,
  ...(search ? { search: { queryId: 1, ...search } } : {}),
});

const searchRow = (db: Db, text: string, chips: Chip[] = []) =>
  searchPage(db, { op: 'search', queryId: 1, text, chips, sort: 'date', after: null }).rows.find(
    (r) => r.threadId === threadOf(db, 'c1'),
  );

describe('lead text', () => {
  it('is the body with each run of white space as one space, trimmed', () => {
    expect(leadText('  Hello,\r\n\r\n  see\tyou\u2028soon.  ')).toBe('Hello, see you soon.');
  });

  it('is at most 200 UTF-16 units, one fewer where the cut would split a surrogate pair', () => {
    const plain = leadText('a'.repeat(500))!;
    expect(plain).toHaveLength(LEAD_UNITS);
    // A pair at units 199 and 200: it is left out whole.
    const split = leadText(`${'a'.repeat(LEAD_UNITS - 1)}\u{1F600}tail`)!;
    expect(split).toBe('a'.repeat(LEAD_UNITS - 1));
    // A pair at units 198 and 199 fits.
    const fits = leadText(`${'a'.repeat(LEAD_UNITS - 2)}\u{1F600}tail`)!;
    expect(fits).toBe(`${'a'.repeat(LEAD_UNITS - 2)}\u{1F600}`);
    expect(fits).toHaveLength(LEAD_UNITS);
  });

  it('removes bidi and zero-width characters and shows controls as symbols', () => {
    expect(leadText('\u202e\u200bPay\u0007 now\u0085!\u2066')).toBe('Pay␇ now�!');
    // Joiners shape letters and emoji: they stay.
    expect(leadText('\u{1F469}\u200d\u{1F4BB} می\u200cروم')).toBe(
      '\u{1F469}\u200d\u{1F4BB} می\u200cروم',
    );
  });

  it('is null for a body of white space and invisible characters only', () => {
    expect(leadText(' \r\n\t\u200b\u202e ')).toBeNull();
    expect(leadText('')).toBeNull();
  });
});

describe('lead lines', () => {
  it('gives indexed and cut bodies their line, in the order asked, each message once', () => {
    const { db, ids } = thread();
    setBody(db, 'c4', 'Cut at the limit, still a line.', BODY_STATE.truncated);
    const answer = leads(db, { rowids: [ids[3]!, ids[0]!, ids[3]!] });
    expect(answer.leads).toEqual([
      { rowid: ids[3], text: 'Cut at the limit, still a line.', snippet: null },
      { rowid: ids[0], text: 'Attached is the invoice for the studio session.', snippet: null },
    ]);
    expect(answer.dropped).toBe(0);
    db.close();
  });

  it('gives no line for a body not indexed yet, one that failed, a gone message, or blank text', () => {
    const { db, ids } = thread();
    setBody(db, 'c1', 'Not read yet.', BODY_STATE.pending);
    setBody(db, 'c2', 'Read but failed.', BODY_STATE.failed);
    setBody(db, 'c3', ' \r\n \u200b ');
    const answer = leads(db, { rowids: [ids[0]!, ids[1]!, ids[2]!, 999_999] });
    expect(answer.leads.map((l) => l.text)).toEqual([null, null, null, null]);
    db.close();
  });

  it('reads a bounded start of the body: a longer leading run of white space gives no line', () => {
    const { db, ids } = thread();
    setBody(db, 'c1', `${' '.repeat(LEAD_READ)}late words`);
    setBody(db, 'c2', `${' '.repeat(LEAD_READ - 6)}early words`);
    const answer = leads(db, { rowids: [ids[0]!, ids[1]!] });
    expect(answer.leads.map((l) => l.text)).toEqual([null, 'early']);
    db.close();
  });

  it('cleans a body that starts with an override, a zero-width space and a control', () => {
    const { db, ids } = thread();
    setBody(db, 'c1', '\u202e\u200b\u0001Hi Sam,\nsee below.');
    expect(leads(db, { rowids: [ids[0]!] }).leads[0]!.text).toBe('␁Hi Sam, see below.');
    db.close();
  });

  it(`refuses more than ${MAX_LEAD_ROWIDS} messages and answers none for none`, () => {
    const { db } = thread();
    const many = Array.from({ length: MAX_LEAD_ROWIDS + 1 }, (_, i) => i + 1);
    expect(() => leads(db, { rowids: many })).toThrow('INVALID');
    expect(leads(db, { rowids: many.slice(0, MAX_LEAD_ROWIDS) }).leads).toHaveLength(
      MAX_LEAD_ROWIDS,
    );
    expect(leads(db, { rowids: [] })).toEqual({ leads: [], dropped: 0 });
    db.close();
  });

  it('with a search, gives matching messages its snippet with checked ranges and the others their lead', () => {
    const { db, ids } = thread();
    const answer = leads(db, { rowids: ids, text: 'invoice' });
    const [c1, c2, c3, c4] = answer.leads;
    for (const lead of [c1!, c3!]) {
      expect(lead.snippet).not.toBeNull();
      expect(validRanges(lead.snippet!.text, lead.snippet!.ranges)).toBe(true);
      const marked = lead.snippet!.ranges.map(([s, e]) => lead.snippet!.text.slice(s, e));
      expect(marked.map((m) => m.toLowerCase())).toContain('invoice');
    }
    // The lead stays alongside, and the others have no snippet.
    expect(c1!.text).toBe('Attached is the invoice for the studio session.');
    expect(c2!.snippet).toBeNull();
    expect(c2!.text).toBe('Thanks, could you add the address to it?');
    expect(c4!.snippet).toBeNull();
    db.close();
  });

  it('matches as the search does: an operator that leaves a message out gives it no snippet', () => {
    const { db, ids } = thread();
    // c3 is from Lee too, but the date leaves it out.
    const answer = leads(db, {
      rowids: ids,
      text: 'invoice from:lee@example.com before:2026-02-01',
    });
    expect(answer.leads.map((l) => l.snippet !== null)).toEqual([true, false, false, false]);
    db.close();
  });

  it('builds snippets only for the messages asked for', () => {
    const { db, ids } = thread();
    const o1 = rowidOf(db, 'o1');
    // o1 matches "invoice" too, in another conversation.
    expect([...matchedSnippets(db, 'invoice', [o1]).byRowid.keys()]).toEqual([o1]);
    const { byRowid, dropped } = matchedSnippets(db, 'invoice', [ids[0]!, ids[1]!]);
    expect([...byRowid.keys()]).toEqual([ids[0]]);
    expect(dropped).toBe(0);
    db.close();
  });

  it('with a filters-only search, gives every message its plain lead', () => {
    const { db, ids } = thread();
    const answer = leads(db, { rowids: ids, text: 'from:lee@example.com' });
    expect(answer.leads.every((l) => l.snippet === null && l.text !== null)).toBe(true);
    db.close();
  });

  it("matches the search's chips as the typed operators: a chip that leaves a message out gives it no snippet", () => {
    const { db, ids } = thread();
    const snipped = (text: string, chips?: Chip[]) =>
      leads(db, { rowids: ids, text, ...(chips ? { chips } : {}) }).leads.map(
        (l) => l.snippet !== null,
      );
    // c1 and c3 say "invoice"; the After chip leaves c1 out, as after: does.
    expect(snipped('invoice', [{ k: 'after', d: '2026-02-01' }])).toEqual([
      false,
      false,
      true,
      false,
    ]);
    expect(snipped('invoice after:2026-02-01')).toEqual([false, false, true, false]);
    // A search of chips only gives every message its plain lead.
    const chipsOnly = leads(db, {
      rowids: ids,
      text: '',
      chips: [{ k: 'from', v: 'lee@example.com' }],
    });
    expect(chipsOnly.leads.every((l) => l.snippet === null && l.text !== null)).toBe(true);
    db.close();
  });
});

describe('cards from a search', () => {
  it('counts the matching messages across the whole conversation, with a smaller window', () => {
    const { db, ids } = thread();
    const w = cardsAnswer(
      db,
      cardsQuery(db, ids[3]!, { text: 'invoice', countRev: null }, 0, 1),
      5,
    );
    expect(w.cards.map((c) => c.rowid)).toEqual([ids[3]]);
    expect(w.total).toBe(4);
    expect(w.matching).toBe(2);
    expect(w.searched).toBe(true);
    expect(w.rev).toBe(5);
    expect(w.cards[0]!.matched).toBe(false);
    db.close();
  });

  it('says which cards match, and only those', () => {
    const { db, ids } = thread();
    const w = cardsAnswer(db, cardsQuery(db, ids[3]!, { text: 'invoice', countRev: null }), 1);
    expect(w.cards.map((c) => c.matched)).toEqual([true, false, true, false]);
    // M agrees with the cards when the whole conversation is in the window.
    expect(w.cards.filter((c) => c.matched)).toHaveLength(w.matching!);
    db.close();
  });

  it('counts only when the count asked for is from another revision than the snapshot', () => {
    const { db, ids } = thread();
    const same = cardsAnswer(db, cardsQuery(db, ids[3]!, { text: 'invoice', countRev: 7 }), 7);
    expect(same.matching).toBeUndefined();
    expect(same.cards.map((c) => c.matched)).toEqual([true, false, true, false]);
    const behind = cardsAnswer(db, cardsQuery(db, ids[3]!, { text: 'invoice', countRev: 6 }), 7);
    expect(behind.matching).toBe(2);
    db.close();
  });

  it("gives the count the result row shows, also when an operator leaves a word's match out", () => {
    const { db, ids } = thread();
    for (const text of [
      'invoice',
      'invoice from:lee@example.com before:2026-02-01',
      'address -paid',
      'from:kim@example.com',
    ]) {
      const w = cardsAnswer(db, cardsQuery(db, ids[3]!, { text, countRev: null }), 1);
      expect(w.matching, text).toBe(searchRow(db, text)!.matching);
    }
    // A filters-only query counts too, and its matching cards are marked.
    const filters = cardsAnswer(
      db,
      cardsQuery(db, ids[3]!, { text: 'from:kim@example.com', countRev: null }),
      1,
    );
    expect(filters.matching).toBe(2);
    expect(filters.cards.map((c) => c.matched)).toEqual([false, true, false, true]);
    db.close();
  });

  it("marks and counts with the search's chips, as the result row does, also with chips only", () => {
    const { db, ids } = thread();
    const after: Chip[] = [{ k: 'after', d: '2026-02-01' }];
    const narrowed = cardsAnswer(
      db,
      cardsQuery(db, ids[3]!, { text: 'invoice', chips: after, countRev: null }),
      1,
    );
    expect(narrowed.cards.map((c) => c.matched)).toEqual([false, false, true, false]);
    expect(narrowed.matching).toBe(1);
    expect(narrowed.matching).toBe(searchRow(db, 'invoice', after)!.matching);
    // Chips with no text still make it a search.
    const lee: Chip[] = [{ k: 'from', v: 'lee@example.com' }];
    const chipsOnly = cardsAnswer(
      db,
      cardsQuery(db, ids[3]!, { text: '', chips: lee, countRev: null }),
      1,
    );
    expect(chipsOnly.searched).toBe(true);
    expect(chipsOnly.cards.map((c) => c.matched)).toEqual([true, false, true, false]);
    expect(chipsOnly.matching).toBe(2);
    expect(chipsOnly.matching).toBe(searchRow(db, '', lee)!.matching);
    db.close();
  });

  it('has no search fields without a search, or once the conversation is gone', () => {
    const { db, ids } = thread();
    const plain = cardsAnswer(db, cardsQuery(db, ids[3]!), 3);
    expect(plain.searched).toBe(false);
    expect(plain.matching).toBeUndefined();
    expect(plain.cards.every((c) => !('matched' in c))).toBe(true);
    expect(plain.rev).toBe(3);
    const gone = cardsAnswer(
      db,
      { ...cardsQuery(db, 999_999, { text: 'invoice', countRev: null }), threadId: 999_999 },
      3,
    );
    expect(gone).toMatchObject({ threadId: null, searched: false });
    db.close();
  });
});

/** An index on disk with the conversation, a writer that commits on its own connection, and a query state. */
function onDisk(name: string) {
  const dbPath = join(testDir(name), 'x.sqlite');
  const writerState = new WriterState();
  const opened = writerState.open({ dbPath, stamp: STAMP, expectedUuid: null, capBytes: null });
  const ids = ['c1', 'c2', 'c3', 'c4'];
  const revs = new Map(
    writerState.apply(
      STAMP,
      ids.map((id) => newPair(id)),
    ).revs,
  );
  writerState.phase1(
    STAMP,
    ids.map((id, i) =>
      item(message(id, i === 0 ? ['c1'] : [id, 'c1'], { time: 100 * (i + 1) }), revs.get(id)!),
    ),
  );
  const other = openDb(dbPath);
  configure(other, 'writer');
  const query = new QueryState();
  query.open(dbPath, opened.uuid);
  const bodies = (id: string, body: string) => setBody(other, id, body);
  for (const id of ids) bodies(id, `${id} plain words`);
  bodies('c1', 'the invoice');
  const ask = (countRev: number | null) =>
    query.run({
      ...cardsQuery(other, rowidOf(other, 'c4'), { text: 'invoice', countRev }),
    }) as CardsWindow;
  return {
    dbPath,
    uuid: opened.uuid,
    query,
    other,
    bodies,
    ask,
    close: () => {
      query.close();
      other.close();
      writerState.close();
    },
  };
}

describe('the snapshot revision', () => {
  it('stays the same while nothing commits and rises after a commit', () => {
    const h = onDisk('rev-commit');
    const first = h.ask(null);
    expect(first.matching).toBe(1);
    const again = h.ask(first.rev);
    expect(again.rev).toBe(first.rev);
    expect(again.matching).toBeUndefined();
    // A commit adds a matching message: the next read has a newer revision and counts it.
    h.bodies('c3', 'another invoice');
    const after = h.ask(first.rev);
    expect(after.rev).toBeGreaterThan(first.rev);
    expect(after.matching).toBe(2);
    expect(after.cards.filter((c) => c.matched)).toHaveLength(2);
    h.close();
  });

  it('is the revision of the snapshot the query pinned, even if a commit lands before it is read', () => {
    const h = onDisk('rev-pin');
    const first = h.ask(null);
    const db = h.query.db!;
    const prepare = db.stmt.bind(db);
    let committed = false;
    // Another connection commits after the query's first statement fixed its
    // snapshot and before the query reads data_version.
    db.stmt = (sql) => {
      if (!committed && sql.includes('data_version')) {
        committed = true;
        h.bodies('c3', 'another invoice');
      }
      return prepare(sql);
    };
    const pinned = h.ask(null);
    expect(committed).toBe(true);
    // The old snapshot, with its old revision: the commit isn't in it.
    expect(pinned.rev).toBe(first.rev);
    expect(pinned.matching).toBe(1);
    db.stmt = prepare;
    // The next query sees the commit, under a new revision.
    const next = h.ask(pinned.rev);
    expect(next.rev).toBe(first.rev + 1);
    expect(next.matching).toBe(2);
    h.close();
  });

  it('rises when the connection opens again, and a new query state starts above its floor', () => {
    const h = onDisk('rev-reopen');
    const first = h.ask(null);
    h.query.open(h.dbPath, h.uuid);
    expect(h.ask(null).rev).toBe(first.rev + 1);
    const replacement = new QueryState();
    replacement.open(h.dbPath, h.uuid, undefined, first.rev + 1);
    const read = replacement.run(
      cardsQuery(h.other, rowidOf(h.other, 'c4'), { text: 'invoice', countRev: null }),
    ) as CardsWindow;
    expect(read.rev).toBe(first.rev + 2);
    replacement.close();
    h.close();
  });

  it('reads lead lines and their snippets from one snapshot', () => {
    const h = onDisk('leads-snapshot');
    const db = h.query.db!;
    const prepare = db.stmt.bind(db);
    let committed = false;
    // A commit between the lead lines and the snippets changes neither.
    db.stmt = (sql) => {
      if (!committed && sql.includes('snippet(fts')) {
        committed = true;
        h.bodies('c1', 'nothing to see');
      }
      return prepare(sql);
    };
    const c1 = rowidOf(h.other, 'c1');
    const answer = h.query.run({ op: 'leads', rowids: [c1], text: 'invoice' }) as LeadsAnswer;
    expect(committed).toBe(true);
    expect(answer.leads[0]!.text).toBe('the invoice');
    expect(answer.leads[0]!.snippet?.text).toBe('the invoice');
    db.stmt = prepare;
    const later = h.query.run({ op: 'leads', rowids: [c1], text: 'invoice' }) as LeadsAnswer;
    expect(later.leads[0]).toMatchObject({ text: 'nothing to see', snippet: null });
    h.close();
  });
});
