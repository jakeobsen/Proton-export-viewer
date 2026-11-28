// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { parseLabels } from '../../src/core/index/labels';
import { searchPage, searchSnippets } from '../../src/core/index/search';
import { asNumber, type Db } from '../../src/core/index/sql';
import { chipTerm, localDay, parseQuery, searchTerms } from '../../src/core/search/query';
import type { SearchQuery, SearchRow, SnippetsQuery } from '../../src/shared/index-types';
import type { Chip } from '../../src/shared/search-chips';
import type { MessageRow } from '../../src/core/index/metadata';
import { STAMP, fresh, ingest, message } from '../index-helpers';

const file = (payload: unknown[]) => JSON.stringify({ Version: 1, Payload: payload });
const single = (id: string, extra: Partial<MessageRow> = {}) => message(id, [id], extra);

function corpus(): Db {
  const { db, writer } = fresh();
  writer.writeLabels(
    STAMP,
    parseLabels(
      file([
        { ID: '0', Name: 'Inbox', Type: 3 },
        { ID: 'f1', Name: 'x y', Path: 'x y', Type: 3 },
        { ID: 'f2', Name: 'Work', Path: 'Work', Type: 3 },
        { ID: 'l1', Name: 'Work', Type: 1 },
        { ID: 'l2', Name: 'a "b": -c', Type: 1 },
        { ID: 'l3', Name: '-x', Type: 1 },
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
        subject: 'budget plan',
        sender: { name: 'Alice Moreau', address: 'alice@example.com' },
        labelIds: ['0', '5', 'l1'],
        unread: 1,
      }),
      single('bob', {
        time: day('2024-01-01'),
        subject: 'budget review',
        sender: { name: 'Bob', address: 'bob@corp.test' },
        labelIds: ['5', 'f1', 'l2'],
        numAttachments: 1,
      }),
      single('carol', {
        time: day('2023-12-31') + 86399,
        subject: 'lunch',
        sender: { name: 'Carol Alicebrook', address: 'carol@other.test' },
        labelIds: ['5', 'f2', 'l3'],
      }),
    ],
    10,
  );
  return db;
}

let queryIds = 0;
function ids(db: Db, text: string, chips: Chip[] = []): string[] {
  queryIds += 1;
  const call = { op: 'search', queryId: queryIds, text, chips, sort: 'date', after: null };
  const rows: SearchRow[] = searchPage(db, call as SearchQuery).rows;
  return rows
    .flatMap((r) =>
      db
        .stmt('SELECT proton_id FROM messages WHERE thread_id = ?')
        .all(r.threadId)
        .map((m) => String(m.proton_id)),
    )
    .sort();
}

describe('search chips', () => {
  it('each match what the typed operator matches', () => {
    const db = corpus();
    const same: Array<[string, Chip]> = [
      ['from:alice', { k: 'from', v: 'alice' }],
      ['from:"Alice Moreau"', { k: 'from', v: 'Alice Moreau' }],
      ['from:alice@example.com', { k: 'from', v: 'alice@example.com' }],
      ['has:attachment', { k: 'attachment' }],
      ['after:2024-01-01', { k: 'after', d: '2024-01-01' }],
      ['label:Work', { k: 'label', id: 'l1' }],
      ['folder:Inbox', { k: 'folder', id: '0' }],
      ['folder:"x y"', { k: 'folder', id: 'f1' }],
      ['is:unread', { k: 'unread' }],
    ];
    for (const [typed, chip] of same) {
      const want = ids(db, typed);
      expect(want.length, typed).toBeGreaterThan(0);
      expect(ids(db, '', [chip]), typed).toEqual(want);
      // The term is the parser's own.
      expect(chipTerm(chip), typed).toEqual({
        ...parseQuery(typed).terms[0],
        ...(chip.k === 'label' || chip.k === 'folder' ? { name: '', id: chip.id } : {}),
      });
    }
    // A From value with a space matches it whole; without, by prefix.
    expect(ids(db, '', [{ k: 'from', v: 'alice' }])).toEqual(['alice', 'carol']);
    expect(ids(db, '', [{ k: 'from', v: 'Alice Moreau' }])).toEqual(['alice']);
  });

  it('match a label or folder by ID only, whatever its name holds', () => {
    const db = corpus();
    expect(ids(db, '', [{ k: 'label', id: 'l2' }])).toEqual(['bob']);
    expect(ids(db, '', [{ k: 'label', id: 'l3' }])).toEqual(['carol']);
    expect(ids(db, '', [{ k: 'folder', id: 'f1' }])).toEqual(['bob']);
    // The same name as a label and a folder: each chip its own.
    expect(ids(db, '', [{ k: 'label', id: 'l1' }])).toEqual(['alice']);
    expect(ids(db, '', [{ k: 'folder', id: 'f2' }])).toEqual(['carol']);
    // An ID the export doesn't have, or one of the other scope, matches nothing.
    expect(ids(db, '', [{ k: 'label', id: 'nope' }])).toEqual([]);
    expect(ids(db, '', [{ k: 'label', id: 'f1' }])).toEqual([]);
    expect(ids(db, '', [{ k: 'folder', id: 'l1' }])).toEqual([]);
    expect(ids(db, '', [{ k: 'label', id: '0' }])).toEqual([]);
  });

  it('add to the typed text and leave it as it is when removed', () => {
    const db = corpus();
    expect(ids(db, 'budget')).toEqual(['alice', 'bob']);
    expect(ids(db, 'budget', [{ k: 'label', id: 'l2' }])).toEqual(['bob']);
    expect(ids(db, 'budget', [{ k: 'label', id: 'l2' }, { k: 'unread' }])).toEqual([]);
    expect(ids(db, 'budget', [])).toEqual(['alice', 'bob']);
    const withChip = searchTerms({ text: 'budget -lunch', chips: [{ k: 'unread' }] }).terms;
    expect(withChip.slice(0, -1)).toEqual(parseQuery('budget -lunch').terms);
  });

  it('search by date with chips and no text, and repeat labels with AND', () => {
    const db = corpus();
    queryIds += 1;
    const page = searchPage(db, {
      op: 'search',
      queryId: queryIds,
      text: '',
      chips: [{ k: 'attachment' }],
      sort: 'relevance',
      after: null,
    });
    expect(page.sort).toBe('date');
    expect(page.total).toBe(1);
    expect(
      ids(db, '', [
        { k: 'label', id: 'l1' },
        { k: 'label', id: 'l2' },
      ]),
    ).toEqual([]);
  });

  it("don't count against the text's term limit", () => {
    const text = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ');
    const { terms, ignored } = searchTerms({ text, chips: [{ k: 'unread' }] });
    expect(ignored).toBe(8);
    expect(terms).toHaveLength(33);
    expect(terms.at(-1)).toEqual({ kind: 'flag', flag: 'unread', negated: false });
  });

  it('give snippets for a From chip, as from: does', () => {
    const db = corpus();
    const rowid = asNumber(
      db.stmt('SELECT thread_id FROM messages WHERE proton_id = ?').get('alice')?.thread_id,
    );
    const asked: SnippetsQuery = { op: 'snippets', queryId: 9, text: '', threadIds: [rowid] };
    const typed = searchSnippets(db, { ...asked, text: 'from:alice' });
    const chipped = searchSnippets(db, { ...asked, chips: [{ k: 'from', v: 'alice' }] });
    expect(typed.snippets[0]!.snippet).not.toBeNull();
    expect(chipped).toEqual(typed);
  });
});
