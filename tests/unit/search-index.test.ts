// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { parseLabels } from '../../src/core/index/labels';
import { BODY_STATE } from '../../src/core/index/schema';
import {
  SEARCH_PAGE_SIZE,
  SNIPPET_ROWS,
  addressItem,
  buildQuery,
  coverageOf,
  ftsLiteral,
  searchPage,
} from '../../src/core/index/search';
import { createSchema } from '../../src/core/index/schema';
import { asNumber, configure, openDb, type Db } from '../../src/core/index/sql';
import { IndexWriter } from '../../src/core/index/writer';
import { localDay, parseQuery } from '../../src/core/search/query';
import { MARK_END, MARK_START, validRanges } from '../../src/core/search/ranges';
import type {
  SearchDateKey,
  SearchKey,
  SearchPage,
  SearchQuery,
  SearchRankKey,
  SearchRow,
} from '../../src/shared/index-types';
import { STAMP, fresh, ingest, message } from '../index-helpers';
import { testDir } from '../paths';
import { join } from 'node:path';
import type { MessageRow } from '../../src/core/index/metadata';

const file = (payload: unknown[]) => JSON.stringify({ Version: 1, Payload: payload });

/** Gives a message its body, as phase 2 would. */
function setBody(db: Db, protonId: string, body: string, state: number = BODY_STATE.indexed) {
  const rowid = rowidOf(db, protonId);
  db.stmt('UPDATE message_text SET body = ? WHERE rowid = ?').run(body, rowid);
  db.stmt('UPDATE pairs SET body_state = ? WHERE proton_id = ?').run(state, protonId);
}

function setAttachments(db: Db, protonId: string, names: string[]) {
  db.stmt('UPDATE message_text SET attachments = ? WHERE rowid = ?').run(
    names.join('\n'),
    rowidOf(db, protonId),
  );
}

const rowidOf = (db: Db, protonId: string) =>
  asNumber(db.stmt('SELECT rowid FROM messages WHERE proton_id = ?').get(protonId)?.rowid);
const threadOf = (db: Db, protonId: string) =>
  asNumber(db.stmt('SELECT thread_id FROM messages WHERE proton_id = ?').get(protonId)?.thread_id);

let queryIds = 0;
function search(
  db: Db,
  text: string,
  sort: 'date' | 'relevance' = 'date',
  after: SearchKey | null = null,
): SearchPage {
  queryIds += 1;
  const call = { op: 'search', queryId: queryIds, text, sort, after } as SearchQuery;
  return searchPage(db, call);
}

/** Every page of a search, following the keysets. */
function allPages(db: Db, text: string, sort: 'date' | 'relevance'): SearchPage[] {
  const pages: SearchPage[] = [];
  let after: SearchKey | null = null;
  for (;;) {
    const page = search(db, text, sort, after);
    pages.push(page);
    if (!page.next) return pages;
    after = page.next;
  }
}

/** The proton IDs of the messages in the conversations of a page. */
function idsIn(db: Db, rows: SearchRow[]): string[] {
  return rows
    .flatMap((r) =>
      db
        .stmt('SELECT proton_id FROM messages WHERE thread_id = ?')
        .all(r.threadId)
        .map((m) => String(m.proton_id)),
    )
    .sort();
}

/** One conversation per message, unless keys join them. */
const single = (id: string, extra: Partial<MessageRow> = {}) => message(id, [id], extra);

describe('grouped search', () => {
  it('groups matching messages by conversation, with counts, the newest match and a snippet', () => {
    const { db, writer } = fresh();
    ingest(
      writer,
      [
        message('a1', ['ka'], { time: 100, subject: 'Budget plan' }),
        message('a2', ['ka2', 'ka'], { time: 300, subject: 'Re: Budget plan', unread: 1 }),
        message('a3', ['ka3', 'ka'], { time: 200, subject: 'Re: lunch' }),
        single('b1', { time: 250, subject: 'budgeting tips', numAttachments: 2 }),
        single('c1', { time: 400, subject: 'Holiday' }),
      ],
      10,
    );
    const page = search(db, 'budget');
    expect(page.sort).toBe('date');
    expect(page.rows.map((r) => [r.threadId, r.time, r.matching, r.count, r.unread])).toEqual([
      [threadOf(db, 'a2'), 300, 2, 3, 1],
      [threadOf(db, 'b1'), 250, 1, 1, 0],
    ]);
    expect(page.rows[0]!.anchorRowid).toBe(rowidOf(db, 'a2'));
    expect(page.rows[1]!.attachments).toBe(true);
    const snippet = page.rows[0]!.snippet!;
    expect(snippet.text).toContain('Budget plan');
    expect(snippet.ranges.map(([s, e]) => snippet.text.slice(s, e).toLowerCase())).toEqual([
      'budget',
    ]);
    expect(page.next).toBeNull();
    expect(page.dropped).toBe(0);
  });

  it('pages by relevance with the best match of each conversation', () => {
    const { db, writer } = fresh();
    ingest(
      writer,
      [
        single('weak', { time: 500, subject: 'report' }),
        single('strong', { time: 100, subject: 'report report report' }),
      ],
      10,
    );
    setBody(db, 'weak', 'nothing much here, filler words, and more filler words to dilute');
    setBody(db, 'strong', 'report on the report');
    const byRank = search(db, 'report', 'relevance');
    expect(byRank.sort).toBe('relevance');
    expect(byRank.rows.map((r) => r.threadId)).toEqual([
      threadOf(db, 'strong'),
      threadOf(db, 'weak'),
    ]);
    expect(byRank.rows[0]!.rank).toBeLessThan(byRank.rows[1]!.rank!);
    const byDate = search(db, 'report', 'date');
    expect(byDate.rows.map((r) => r.threadId)).toEqual([
      threadOf(db, 'weak'),
      threadOf(db, 'strong'),
    ]);
    expect(byDate.rows.every((r) => r.rank === null)).toBe(true);
  });

  it('breaks ties: the snippet from the best-ranked match, then the newer, then the higher rowid', () => {
    const { db, writer } = fresh();
    ingest(
      writer,
      [
        message('t1', ['kt'], { time: 100, subject: 'alpha first' }),
        message('t2', ['kt2', 'kt'], { time: 100, subject: 'alpha second' }),
        message('t3', ['kt3', 'kt'], { time: 50, subject: 'alpha third' }),
      ],
      10,
    );
    // The same rank for all three: the newer time wins, then the higher rowid.
    const row = search(db, 'alpha', 'relevance').rows[0]!;
    expect(row.matching).toBe(3);
    expect(row.anchorRowid).toBe(rowidOf(db, 't2'));
    expect(row.snippet!.text).toBe('alpha second');
    // The newest matching message is the newest by time, ties to the higher rowid.
    expect(search(db, 'alpha').rows[0]!.anchorRowid).toBe(rowidOf(db, 't2'));
    expect(search(db, 'third').rows[0]!.anchorRowid).toBe(rowidOf(db, 't3'));
  });

  it('opens a conversation at its newest matching message, not its newest message', () => {
    const { db, writer } = fresh();
    ingest(
      writer,
      [
        message('old', ['k'], { time: 10, subject: 'needle' }),
        message('new', ['k2', 'k'], { time: 20, subject: 'hay' }),
      ],
      10,
    );
    const row = search(db, 'needle').rows[0]!;
    expect(row.time).toBe(10);
    expect(row.anchorRowid).toBe(rowidOf(db, 'old'));
    expect(row.count).toBe(2);
    expect(row.matching).toBe(1);
  });

  it('gives snippets to the first rows of a page only', () => {
    const { db, writer } = fresh();
    ingest(
      writer,
      Array.from({ length: SNIPPET_ROWS + 5 }, (_, i) =>
        single(`s${i}`, { time: i, subject: 'zeta' }),
      ),
      100,
    );
    const rows = search(db, 'zeta').rows;
    expect(rows).toHaveLength(SNIPPET_ROWS + 5);
    expect(rows.slice(0, SNIPPET_ROWS).every((r) => r.snippet !== null)).toBe(true);
    expect(rows.slice(SNIPPET_ROWS).every((r) => r.snippet === null)).toBe(true);
  });
});

describe('page boundaries', () => {
  /**
   * 450 conversations, one of them with 30 matching messages spread over the
   * whole date range, so it is near the boundary of every page by date.
   */
  function corpus() {
    const { db, writer } = fresh();
    const rows: MessageRow[] = [];
    for (let i = 0; i < 450; i += 1) {
      // Ties on time, in groups of three.
      rows.push(single(`m${i}`, { time: 1000 + Math.floor(i / 3), subject: `common ${i}` }));
    }
    for (let j = 0; j < 30; j += 1) {
      const keys = j === 0 ? ['big'] : [`big${j}`, 'big'];
      rows.push(message(`big${j}`, keys, { time: 1000 + j * 5, subject: `common big ${j}` }));
    }
    ingest(writer, rows, 120);
    // Bodies of differing length, so relevance has spread and ties.
    for (let i = 0; i < 450; i += 1) setBody(db, `m${i}`, `common ${'x '.repeat(i % 7)}`);
    return db;
  }

  for (const sort of ['date', 'relevance'] as const) {
    it(`by ${sort}: full pages of distinct conversations, none left out or repeated`, () => {
      const db = corpus();
      const pages = allPages(db, 'common', sort);
      expect(pages.map((p) => p.rows.length)).toEqual([SEARCH_PAGE_SIZE, SEARCH_PAGE_SIZE, 51]);
      const seen = pages.flatMap((p) => p.rows.map((r) => r.threadId));
      expect(new Set(seen).size).toBe(seen.length);
      const all = asNumber(db.stmt('SELECT count(DISTINCT thread_id) AS n FROM messages').get()?.n);
      expect(seen).toHaveLength(all);
      // Each page continues exactly where the previous one ended.
      const order = pages.flatMap((p) => p.rows);
      for (let i = 1; i < order.length; i += 1) {
        const a = order[i - 1]!;
        const b = order[i]!;
        if (sort === 'date') {
          expect(a.time > b.time || (a.time === b.time && a.threadId > b.threadId)).toBe(true);
        } else {
          expect(a.rank! < b.rank! || (a.rank === b.rank && a.threadId > b.threadId)).toBe(true);
        }
      }
      expect(order.find((r) => r.matching === 30)).toBeDefined();
      expect(pages[0]!.next).toEqual(
        sort === 'date'
          ? ({
              time: pages[0]!.rows.at(-1)!.time,
              threadId: pages[0]!.rows.at(-1)!.threadId,
            } as SearchDateKey)
          : ({
              rank: pages[0]!.rows.at(-1)!.rank!,
              threadId: pages[0]!.rows.at(-1)!.threadId,
            } as SearchRankKey),
      );
    });
  }

  it('a relevance keyset for a query with no words to rank continues nothing', () => {
    const db = corpus();
    const first = search(db, 'is:unread OR', 'relevance');
    expect(first.sort).toBe('relevance');
    const page = search(db, '-common', 'relevance', { rank: -1, threadId: 5 });
    expect(page.sort).toBe('date');
    expect(page.rows).toEqual([]);
    expect(page.next).toBeNull();
  });
});

describe('operators', () => {
  function corpus() {
    const { db, writer } = fresh();
    writer.writeLabels(
      STAMP,
      parseLabels(
        file([
          { ID: '0', Name: 'Inbox', Type: 3 },
          { ID: 'f1', Name: 'Clients', Path: 'Clients', Type: 3 },
          { ID: 'f2', Name: 'Acme', Path: 'Clients/Acme', Type: 3, ParentID: 'f1' },
          { ID: 'l1', Name: 'Work', Type: 1 },
          { ID: 'l2', Name: 'Ärger', Type: 1 },
        ]),
      ),
      '{}',
    );
    const day = (d: string) => localDay(d)!;
    ingest(
      writer,
      [
        single('alice', {
          time: day('2024-01-10') + 3600,
          sender: { name: 'Alice Smith', address: 'Alice.Smith@Example.com' },
          to: [{ name: 'Bob', address: 'bob@corp.test' }],
          labelIds: ['0', '5', 'l1'],
          unread: 1,
          size: 2048,
        }),
        single('bob', {
          time: day('2024-01-11'),
          sender: { name: 'Bob', address: 'bob@corp.test' },
          cc: [{ name: 'Alice', address: 'alice.smith@example.com' }],
          labelIds: ['5', 'f2', '10'],
          replied: 1,
          numAttachments: 1,
          size: 5 * 1024 * 1024,
        }),
        single('carol', {
          time: day('2024-01-09') + 86399,
          sender: { name: 'Carol', address: 'carol@other.test' },
          labelIds: ['5', 'f1', 'l2'],
          repliedAll: 1,
          size: 100,
        }),
      ],
      10,
    );
    setBody(db, 'alice', 'quarterly numbers attached');
    setAttachments(db, 'bob', ['q3 report.pdf', 'notes.txt']);
    return db;
  }
  const ids = (db: Db, text: string) => idsIn(db, search(db, text).rows);

  it('match addresses exactly or by prefix, ignoring case, and names in the text', () => {
    const db = corpus();
    expect(ids(db, 'from:alice.smith@example.com')).toEqual(['alice']);
    expect(ids(db, 'from:ALICE.SMITH@EXA')).toEqual(['alice']);
    expect(ids(db, 'from:alice.smith@example.c')).toEqual(['alice']);
    expect(ids(db, 'from:smith@example.com')).toEqual([]);
    expect(ids(db, 'from:@example.com')).toEqual([]);
    expect(ids(db, 'from:alice')).toEqual(['alice']);
    expect(ids(db, 'from:"alice smith"')).toEqual(['alice']);
    expect(ids(db, 'to:bob@corp.test')).toEqual(['alice']);
    expect(ids(db, 'cc:alice.smith@')).toEqual(['bob']);
    expect(ids(db, 'to:alice.smith@')).toEqual([]);
    expect(ids(db, 'to:bob')).toEqual(['alice']);
    expect(ids(db, '-from:bob@corp.test')).toEqual(['alice', 'carol']);
  });

  it('match addresses with letters outside ASCII in any case', () => {
    const { db, writer } = fresh();
    ingest(
      writer,
      [
        single('elodie', {
          sender: { name: 'Élodie', address: 'Élodie@Exemple.fr' },
          to: [{ name: '', address: 'ÉLODIE.B@exemple.fr' }],
          cc: [{ name: '', address: 'Ørjan@Exemple.no' }],
        }),
        single('other', { sender: { name: 'Elodie', address: 'elodie@exemple.fr' } }),
      ],
      10,
    );
    const ids = (text: string) => idsIn(db, search(db, text).rows);
    expect(ids('from:élodie@exemple.fr')).toEqual(['elodie']);
    expect(ids('from:ÉLODIE@')).toEqual(['elodie']);
    expect(ids('from:Élodie@EXEMPLE.FR')).toEqual(['elodie']);
    // Folding is case only: an accent still counts.
    expect(ids('from:elodie@')).toEqual(['other']);
    expect(ids('to:élodie.b@')).toEqual(['elodie']);
    expect(ids('to:Élodie.B@exemple.fr')).toEqual(['elodie']);
    expect(ids('cc:ørjan@exemple.no')).toEqual(['elodie']);
    expect(ids('cc:ØRJAN@')).toEqual(['elodie']);
  });

  it('match a stored address in its own case and in another, in each address field', () => {
    const { db, writer } = fresh();
    ingest(
      writer,
      [
        single('stored', {
          sender: { name: 'Élodie', address: 'Élodie@example.test' },
          to: [{ name: 'Özge', address: 'Özge@example.test' }],
          cc: [{ name: 'Åsa', address: 'Åsa@example.test' }],
        }),
        single('greek', { sender: { name: '', address: 'odysseas@ΟΔΥΣΣΕΑΣ.test' } }),
      ],
      10,
    );
    const ids = (text: string) => idsIn(db, search(db, text).rows);
    expect(ids('from:Élodie@example.test')).toEqual(['stored']);
    expect(ids('from:élodie@example.test')).toEqual(['stored']);
    expect(ids('to:Özge@example.test')).toEqual(['stored']);
    expect(ids('to:özge@example.test')).toEqual(['stored']);
    expect(ids('cc:Åsa@example.test')).toEqual(['stored']);
    expect(ids('cc:åsa@example.test')).toEqual(['stored']);
    // A typed prefix may stop on a capital sigma, which JavaScript folds to a
    // final one, where the stored address goes on with a plain one.
    expect(ids('from:odysseas@ΟΔΥΣ')).toEqual(['greek']);
    expect(ids('from:odysseas@οδυς')).toEqual(['greek']);
    expect(ids('from:ODYSSEAS@ΟΔΥΣΣΕΑΣ.test')).toEqual(['greek']);
  });

  it('match subjects, attachment names and words', () => {
    const db = corpus();
    expect(ids(db, 'subject:alice')).toEqual(['alice']);
    expect(ids(db, 'subject:quarterly')).toEqual([]);
    expect(ids(db, 'quarterly')).toEqual(['alice']);
    // A stray combining mark typed as its own word changes nothing.
    expect(ids(db, 'quarterly \u0301')).toEqual(['alice']);
    expect(ids(db, 'from:alice.smith@example.com \u0301\u0301')).toEqual(['alice']);
    expect(ids(db, 'filename:report')).toEqual(['bob']);
    expect(ids(db, 'filename:"q3 report"')).toEqual(['bob']);
    expect(ids(db, 'filename:notes.txt')).toEqual(['bob']);
    expect(ids(db, 'filename:quarterly')).toEqual([]);
  });

  it('match folders and labels by name or path in any case, and flags', () => {
    const db = corpus();
    expect(ids(db, 'label:work')).toEqual(['alice']);
    expect(ids(db, 'label:ärger')).toEqual(['carol']);
    expect(ids(db, 'label:clients')).toEqual([]);
    expect(ids(db, 'folder:clients')).toEqual(['carol']);
    expect(ids(db, 'folder:"clients/acme"')).toEqual(['bob']);
    expect(ids(db, 'folder:acme')).toEqual(['bob']);
    expect(ids(db, 'folder:inbox')).toEqual(['alice']);
    expect(ids(db, 'folder:"all mail"')).toEqual(['alice', 'bob', 'carol']);
    expect(ids(db, 'label:nothing')).toEqual([]);
    expect(ids(db, '-label:nothing')).toEqual(['alice', 'bob', 'carol']);
    expect(ids(db, 'is:unread')).toEqual(['alice']);
    expect(ids(db, 'is:starred')).toEqual(['bob']);
    expect(ids(db, 'is:replied')).toEqual(['bob', 'carol']);
    expect(ids(db, 'has:attachment')).toEqual(['bob']);
    expect(ids(db, '-is:unread -has:attachment')).toEqual(['carol']);
  });

  it('match local days and sizes', () => {
    const db = corpus();
    expect(ids(db, 'after:2024-01-10')).toEqual(['alice', 'bob']);
    expect(ids(db, 'before:2024-01-10')).toEqual(['carol']);
    expect(ids(db, 'after:2024-01-10 before:2024-01-11')).toEqual(['alice']);
    // A message at the very start of the day is in it.
    expect(ids(db, 'after:2024-01-11')).toEqual(['bob']);
    expect(ids(db, 'before:2024-01-11')).toEqual(['alice', 'carol']);
    expect(ids(db, 'larger:1M')).toEqual(['bob']);
    expect(ids(db, 'smaller:2K')).toEqual(['carol']);
    expect(ids(db, 'larger:2K smaller:5M')).toEqual([]);
    expect(ids(db, 'larger:2047 smaller:2049')).toEqual(['alice']);
  });

  it('with only filters, sorts by date and gives no snippet', () => {
    const db = corpus();
    const page = search(db, 'folder:"all mail"', 'relevance');
    expect(page.sort).toBe('date');
    expect(page.rows.map((r) => r.time)).toEqual(
      [...page.rows.map((r) => r.time)].sort((a, b) => b - a),
    );
    expect(page.rows.every((r) => r.snippet === null && r.rank === null)).toBe(true);
  });

  it('with only negated words, gives everything else by date', () => {
    const db = corpus();
    const page = search(db, '-quarterly -report', 'relevance');
    expect(page.sort).toBe('date');
    expect(idsIn(db, page.rows)).toEqual(['carol']);
    expect(idsIn(db, search(db, '-nomatch').rows)).toEqual(['alice', 'bob', 'carol']);
    expect(idsIn(db, search(db, 'is:replied -report').rows)).toEqual(['carol']);
  });

  it('gives nothing for a query with nothing to match', () => {
    const db = corpus();
    for (const text of ['', '   ', '--- !!! "" * ^', '\u0000\u0001']) {
      const page = search(db, text);
      expect(page.rows, JSON.stringify(text)).toEqual([]);
      expect(page.next).toBeNull();
    }
  });
});

describe('text that is not syntax', () => {
  function corpus() {
    const { db, writer } = fresh();
    ingest(
      writer,
      [
        single('p1', { time: 3, subject: 'NEAR OR AND NOT' }),
        single('p2', { time: 2, subject: 'o\'brien said "hi" (twice)' }),
        single('p3', { time: 1, subject: 'plain' }),
      ],
      10,
    );
    return db;
  }

  it('reads full-text operators and SQL as words', () => {
    const db = corpus();
    expect(idsIn(db, search(db, 'NEAR OR').rows)).toEqual(['p1']);
    expect(idsIn(db, search(db, 'AND NOT').rows)).toEqual(['p1']);
    expect(idsIn(db, search(db, "o'brien").rows)).toEqual(['p2']);
    expect(idsIn(db, search(db, '"said hi"').rows)).toEqual(['p2']);
    expect(idsIn(db, search(db, '(twice)').rows)).toEqual(['p2']);
  });

  it('never fails on hostile text', () => {
    const db = corpus();
    const hostile = [
      '"',
      '""""',
      '*',
      'a*b*',
      '^start',
      'col:*',
      '{subject body}:x',
      'subject:{x}',
      'x NEAR/3 y',
      'NEAR(x y, 2)',
      'x + y',
      '-',
      '--',
      '- -x',
      '-"',
      'from:"',
      'label:"',
      "'); DROP TABLE messages; --",
      '1=1 OR 1=1',
      '\\" OR rowid > 0 --',
      'from:x@y\'"; --',
      "label:'; DELETE FROM labels; --",
      `${'('.repeat(500)}x`,
      'x'.repeat(5000),
      Array.from({ length: 200 }, (_, i) => `w${i}`).join(' '),
      Array.from({ length: 200 }, () => '-x').join(' '),
      '𐀀\ud800 \udfff',
      '‮‏⁦ rtl',
      '😀 🏳️‍🌈 👨‍👩‍👧',
      'ﷺ ẞ ǅ',
      'a\u0000b',
    ];
    for (const text of hostile) {
      for (const sort of ['date', 'relevance'] as const) {
        expect(() => search(db, text, sort), text.slice(0, 40)).not.toThrow();
      }
    }
    // The tables are as they were.
    expect(asNumber(db.stmt('SELECT count(*) AS n FROM messages').get()?.n)).toBe(3);
  });

  it('puts user text into the match expression only as quoted literals', () => {
    const db = corpus();
    const built = buildQuery(db, parseQuery('alpha subject:"x y" -NEAR from:qq@rr'));
    expect(built.match).toBe(
      '("alpha"* AND {subject} : "x y" AND {sender} : "qq rr"*) NOT ("NEAR"*)',
    );
    expect(built.conditions.map((c) => c.params)).toEqual([['qq@rr', 'qq@rr']]);
    expect(ftsLiteral('say "hi"')).toBe('"say ""hi"""');
    expect(addressItem('alice@exa', 'sender')).toBe('{sender} : "alice exa"*');
    expect(addressItem('alice@example.c', 'sender')).toBe('{sender} : "alice example"');
    expect(addressItem('alice@', 'sender')).toBe('{sender} : "alice"');
    expect(addressItem('@', 'sender')).toBeNull();
  });
});

describe('snippet ranges', () => {
  function withSubject(subject: string, body = '') {
    const { db, writer } = fresh();
    ingest(writer, [single('u', { subject })], 1);
    if (body) setBody(db, 'u', body);
    return db;
  }
  const marked = (db: Db, query: string) => {
    const s = search(db, query).rows[0]?.snippet;
    if (!s) throw new Error(`no snippet for ${query}`);
    expect(validRanges(s.text, s.ranges)).toBe(true);
    return s.ranges.map(([a, b]) => s.text.slice(a, b));
  };

  it('are UTF-16 ranges for emoji, astral characters, combining marks, RTL, CJK and folded diacritics', () => {
    expect(marked(withSubject('🙂 smile 😀 smile'), 'smile')).toEqual(['smile', 'smile']);
    expect(marked(withSubject('𝒳yz and 𝒳yz'), '𝒳yz')).toEqual(['𝒳yz', '𝒳yz']);
    expect(marked(withSubject('café au lait'), 'cafe')).toEqual(['café']);
    expect(marked(withSubject('Crème Brûlée'), 'creme brulee')).toEqual(['Crème', 'Brûlée']);
    expect(marked(withSubject('שלום עולם hello'), 'עולם')).toEqual(['עולם']);
    expect(marked(withSubject('مرحبا بالعالم'), 'مرحبا')).toEqual(['مرحبا']);
    expect(marked(withSubject('東京タワー 大阪'), '東京タワー')).toEqual(['東京タワー']);
    expect(marked(withSubject('ÅNGSTRÖM unit'), 'angstrom')).toEqual(['ÅNGSTRÖM']);
  });

  it('come from the body when it matches best', () => {
    const db = withSubject(
      'nothing',
      `intro ${'filler '.repeat(40)}the needle is here ${'tail '.repeat(40)}`,
    );
    const s = search(db, 'needle').rows[0]!.snippet!;
    expect(s.text.startsWith('…') || s.text.endsWith('…')).toBe(true);
    expect(s.ranges.map(([a, b]) => s.text.slice(a, b))).toEqual(['needle']);
  });

  it('never carry mark characters from a subject or sender: they are stripped when indexed', () => {
    const { db, writer } = fresh();
    ingest(
      writer,
      [
        single('s', {
          subject: `${MARK_START}fake${MARK_END} real ${MARK_END}`,
          sender: { name: `Eve ${MARK_START}x`, address: 'eve@example.com' },
        }),
      ],
      1,
    );
    const text = db.stmt('SELECT subject, sender FROM message_text').get()!;
    expect(String(text.subject)).toBe('fake real ');
    expect(String(text.sender)).toBe('Eve x eve@example.com');
    const real = search(db, 'real').rows[0]!.snippet!;
    expect(real.ranges.map(([a, b]) => real.text.slice(a, b))).toEqual(['real']);
    const fake = search(db, 'fake').rows[0]!.snippet!;
    expect(fake.text).toBe('fake real ');
    expect(fake.ranges).toEqual([[0, 4]]);
    const eve = search(db, 'from:eve').rows[0]!.snippet!;
    expect(eve.ranges.map(([a, b]) => eve.text.slice(a, b).toLowerCase())).toEqual(['eve', 'eve']);
    expect(search(db, 'fake').dropped).toBe(0);
  });

  it('drop a marked text that does not convert, counted, and give the text without marks', () => {
    const { db, writer } = fresh();
    ingest(writer, [single('d', { subject: 'clean' })], 1);
    // Mark characters written past the stripping, as an older index could hold them.
    db.stmt('UPDATE message_text SET subject = ? WHERE rowid = ?').run(
      `clean ${MARK_END}`,
      rowidOf(db, 'd'),
    );
    const page = search(db, 'clean');
    expect(page.dropped).toBe(1);
    expect(page.rows[0]!.snippet).toEqual({ text: 'clean ', ranges: [] });
  });
});

describe('coverage', () => {
  it('counts the messages whose body is in the index, read again after another connection commits', () => {
    const path = join(testDir('search-coverage'), 'index.db');
    const db = openDb(path);
    configure(db, 'writer');
    createSchema(db, STAMP.generation);
    const writer = new IndexWriter(db, STAMP);
    ingest(writer, [single('x'), single('y'), single('z')], 10);
    const reader = openDb(path, true);
    configure(reader, 'reader');
    try {
      expect(coverageOf(reader)).toEqual({ indexed: 0, total: 3 });
      expect(search(reader, 'x').coverage).toEqual({ indexed: 0, total: 3 });
      setBody(db, 'x', 'body');
      setBody(db, 'y', 'cut', BODY_STATE.truncated);
      setBody(db, 'z', '', BODY_STATE.failed);
      expect(coverageOf(reader)).toEqual({ indexed: 2, total: 3 });
      expect(search(reader, 'body').coverage).toEqual({ indexed: 2, total: 3 });
    } finally {
      reader.close();
      db.close();
    }
  });
});

describe('prepared statements', () => {
  it('keeps no statement for SQL that varies with the query', () => {
    const { db, writer } = fresh();
    ingest(writer, [single('q', { subject: 'kept' })], 1);
    const cached: string[] = [];
    const stmt = db.stmt.bind(db);
    db.stmt = (sql: string) => {
      cached.push(sql);
      return stmt(sql);
    };
    for (let i = 0; i < 20; i += 1) search(db, `kept ${'-x '.repeat(i)}is:unread larger:${i}`);
    // Only the fixed statements are cached, however many shapes the queries had.
    expect(new Set(cached).size).toBeLessThanOrEqual(5);
    expect(cached.some((sql) => sql.includes('fts MATCH ?') && sql.includes('GROUP BY'))).toBe(
      false,
    );
  });
});
