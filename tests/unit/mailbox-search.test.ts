// SPDX-License-Identifier: AGPL-3.0-or-later
// The shell's search and the cards it opens: what a selected result put on
// screen goes when the results go, even after its conversation's ID changed,
// and cards the result didn't open stay.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cardsWindow } from '../../src/core/index/queries';
import { asNumber, type Db } from '../../src/core/index/sql';
import type { IndexWriter } from '../../src/core/index/writer';
import type { CardsQuery, IndexProgress, SearchPage } from '../../src/shared/index-types';
import type { Row } from '../../src/renderer/list';
import { TYPING_PAUSE_MS } from '../../src/renderer/search';
import { fresh, ingest, message } from '../index-helpers';

const GENERATION = 1;
const PROGRESS: IndexProgress = {
  phase: 'done',
  loaded: 5,
  total: 5,
  failed: 0,
  timeouts: 0,
} as IndexProgress;

let db: Db;
let writer: IndexWriter;
/** What the search answers: one row, set by each test. */
let page: SearchPage | null = null;

const pev = {
  state: vi.fn(async () => ({ ok: true, generation: GENERATION })),
  sources: vi.fn(async () => ({
    ok: true,
    generation: GENERATION,
    sources: { restoring: false, active: { sourceKey: 'export-1' }, recent: [] },
  })),
  sidebar: vi.fn(async () => ({ ok: false, code: 'core_unavailable' })),
  listWindow: vi.fn(async () => ({ ok: false, code: 'core_unavailable' })),
  cards: vi.fn(async (query: CardsQuery) => ({
    ok: true,
    generation: GENERATION,
    answer: cardsWindow(db, query),
    progress: PROGRESS,
  })),
  search: vi.fn(async () =>
    page
      ? { ok: true, generation: GENERATION, queryId: page.queryId, page, progress: PROGRESS }
      : { ok: false, code: 'core_unavailable' },
  ),
  searchSnippets: vi.fn(async () => ({ ok: true, generation: GENERATION, snippets: [] })),
  // From search, the view says how the message matched: as many body matches as the search's ID.
  open: vi.fn(async (_rowid: number, _mode: string, _generation: number, queryId?: number) => ({
    ok: true,
    outcome: 'view',
    url: 'about:blank',
    match:
      queryId === undefined
        ? null
        : { state: 1, reason: null, columns: [], bodyMatches: queryId, changed: false },
  })),
  closeView: vi.fn(async () => ({ ok: true })),
};
(globalThis as unknown as { window: { pev: typeof pev } }).window = { pev };

const shell = await import('../../src/renderer/shell');
const reader = await import('../../src/renderer/reader');
const mailbox = await import('../../src/renderer/mailbox-state');

const rowidOf = (id: string) =>
  asNumber(db.stmt('SELECT rowid FROM messages WHERE proton_id = ?').get(id)?.rowid);
const threadOf = (id: string) =>
  asNumber(db.stmt('SELECT thread_id FROM messages WHERE proton_id = ?').get(id)?.thread_id);
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

/** A one-row page whose result opens message `id` in its conversation. */
function resultFor(id: string): SearchPage {
  const threadId = threadOf(id);
  return {
    queryId: 1,
    sort: 'date',
    ranked: true,
    total: 1,
    rows: [
      {
        threadId,
        time: 1,
        rank: null,
        count: 1,
        unread: 0,
        attachments: false,
        matching: 1,
        anchorRowid: rowidOf(id),
        snippet: null,
      },
    ],
    details: [{ threadId, subject: id, participants: [], labelIds: [] }],
    next: null,
    coverage: { indexed: 5, pending: 0, total: 5 },
    dropped: 0,
  } as SearchPage;
}

/** Types `text` and waits until its results show. */
async function searchFor(text: string): Promise<void> {
  mailbox.setSearchText(text);
  vi.advanceTimersByTime(TYPING_PAUSE_MS);
  await flush();
  expect(mailbox.search.snapshot).toMatchObject({ resultsFor: text, searching: false });
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await shell.refreshSources();
  mailbox.syncMailbox();
  expect(mailbox.getMailboxState().key).toBe(`export-1:${GENERATION}`);
});

afterAll(() => {
  vi.useRealTimers();
});

afterEach(async () => {
  mailbox.clearSearch();
  mailbox.cards.hide();
  reader.closeReader();
  await flush();
  db.close();
  vi.clearAllMocks();
});

/**
 * Three conversations: "big" (three messages), "small" (one) and "solo"
 * (one). A merge keeps the bigger conversation's ID.
 */
function setup(): void {
  ({ db, writer } = fresh());
  ingest(
    writer,
    [
      message('b0', ['b0'], { time: 100 }),
      message('b1', ['b1', 'b0'], { time: 101 }),
      message('b2', ['b2', 'b0'], { time: 102 }),
      message('s0', ['s0'], { time: 200 }),
      message('solo', ['solo'], { time: 300 }),
    ],
    50,
  );
}

describe('cards a search result opened', () => {
  it('close with the results after a merge gave their conversation another ID', async () => {
    setup();
    const smallThread = threadOf('s0');
    const bigThread = threadOf('b0');
    page = resultFor('s0');
    await searchFor('small');
    mailbox.selectResult(mailbox.search.snapshot.rows[0]!);
    await flush();
    expect(mailbox.cards.snapshot).toMatchObject({
      shown: true,
      threadId: smallThread,
      expanded: rowidOf('s0'),
    });
    expect(reader.getReaderState().rowid).toBe(rowidOf('s0'));

    // A message joins the two conversations: the bigger one's ID stays, and the cards follow.
    ingest(writer, [message('link', ['link', 's0', 'b0'], { time: 400 })], 1);
    mailbox.indexChanged({ generation: GENERATION, progress: PROGRESS });
    await flush();
    expect(mailbox.cards.snapshot).toMatchObject({
      shown: true,
      threadId: bigThread,
      expanded: rowidOf('s0'),
    });
    expect(bigThread).not.toBe(smallThread);
    expect(mailbox.search.snapshot.selected?.threadId).toBe(smallThread);

    mailbox.clearSearch();
    expect(mailbox.cards.snapshot.shown).toBe(false);
    expect(reader.getReaderState().rowid).toBeNull();
    expect(pev.closeView).toHaveBeenCalledTimes(1);
    expect(pev.closeView).toHaveBeenCalledWith(GENERATION);
  });

  it('close with the results when the box is emptied, after the same merge', async () => {
    setup();
    page = resultFor('s0');
    await searchFor('small');
    mailbox.selectResult(mailbox.search.snapshot.rows[0]!);
    await flush();
    ingest(writer, [message('link', ['link', 's0', 'b0'], { time: 400 })], 1);
    mailbox.indexChanged({ generation: GENERATION, progress: PROGRESS });
    await flush();
    expect(mailbox.cards.snapshot.threadId).toBe(threadOf('b0'));

    mailbox.setSearchText('');
    expect(mailbox.cards.snapshot.shown).toBe(false);
    expect(reader.getReaderState().rowid).toBeNull();
  });

  it('close with the results once no message of their conversation is left', async () => {
    setup();
    page = resultFor('s0');
    await searchFor('small');
    mailbox.selectResult(mailbox.search.snapshot.rows[0]!);
    await flush();
    db.exec(`DELETE FROM messages WHERE rowid = ${rowidOf('s0')}`);
    mailbox.indexChanged({ generation: GENERATION, progress: PROGRESS });
    await flush();
    // The cards say the conversation is gone; they still show, with no ID.
    expect(mailbox.cards.snapshot).toMatchObject({ shown: true, gone: true, threadId: null });

    mailbox.clearSearch();
    expect(mailbox.cards.snapshot.shown).toBe(false);
    expect(reader.getReaderState().rowid).toBeNull();
  });

  it('a result for the conversation already shown takes it over, and it closes with the results', async () => {
    setup();
    mailbox.selectRow({ threadId: threadOf('s0'), newestRowid: rowidOf('s0') } as Row);
    await flush();
    expect(reader.getReaderState()).toMatchObject({ rowid: rowidOf('s0'), queryId: null });
    expect(reader.getReaderState().match).toBeNull();
    const showing = mailbox.cards.showing;
    page = resultFor('s0');
    await searchFor('small');
    mailbox.selectResult(mailbox.search.snapshot.rows[0]!);
    await flush();
    // Shown already, but opened from the folder: it opens again, from the
    // search, so the reader shows how it matched. The cards stay.
    expect(pev.open).toHaveBeenCalledTimes(2);
    expect(pev.open).toHaveBeenLastCalledWith(rowidOf('s0'), 'html', GENERATION, 1);
    expect(reader.getReaderState()).toMatchObject({ rowid: rowidOf('s0'), queryId: 1 });
    expect(reader.getReaderState().match).toMatchObject({ bodyMatches: 1 });
    expect(mailbox.cards.showing).toBe(showing);
    expect(mailbox.list.snapshot.selected).toBeNull();

    // The same result again: shown for this search already, so no open.
    mailbox.selectResult(mailbox.search.snapshot.rows[0]!);
    await flush();
    expect(pev.open).toHaveBeenCalledTimes(2);

    mailbox.clearSearch();
    expect(mailbox.cards.snapshot.shown).toBe(false);
    expect(reader.getReaderState().rowid).toBeNull();
  });

  it("a result shown for another search opens again for this one, with this search's matches", async () => {
    setup();
    page = { ...resultFor('s0'), queryId: 3 };
    await searchFor('small');
    mailbox.selectResult(mailbox.search.snapshot.rows[0]!);
    await flush();
    expect(pev.open).toHaveBeenCalledTimes(1);
    expect(reader.getReaderState().match).toMatchObject({ bodyMatches: 3 });
    const showing = mailbox.cards.showing;

    page = { ...resultFor('s0'), queryId: 4 };
    await searchFor('smaller');
    expect(mailbox.search.currentQueryId).toBe(4);
    mailbox.selectResult(mailbox.search.snapshot.rows[0]!);
    await flush();
    expect(pev.open).toHaveBeenCalledTimes(2);
    expect(pev.open).toHaveBeenLastCalledWith(rowidOf('s0'), 'html', GENERATION, 4);
    expect(reader.getReaderState()).toMatchObject({ rowid: rowidOf('s0'), queryId: 4 });
    expect(reader.getReaderState().match).toMatchObject({ bodyMatches: 4 });
    expect(mailbox.cards.showing).toBe(showing);

    mailbox.selectResult(mailbox.search.snapshot.rows[0]!);
    await flush();
    expect(pev.open).toHaveBeenCalledTimes(2);
  });

  it("opens in a result's conversation name its search; outside search they don't", async () => {
    setup();
    page = { ...resultFor('b2'), queryId: 7 };
    await searchFor('big');
    expect(mailbox.search.currentQueryId).toBe(7);
    mailbox.selectResult(mailbox.search.snapshot.rows[0]!);
    await flush();
    expect(pev.open).toHaveBeenLastCalledWith(rowidOf('b2'), 'html', GENERATION, 7);
    expect(reader.getReaderState().queryId).toBe(7);
    // Another card, and the body switch, keep it.
    const older = mailbox.cards.snapshot.cards.find((c) => c.rowid === rowidOf('b1'))!;
    mailbox.expandCard(older);
    await flush();
    expect(pev.open).toHaveBeenLastCalledWith(rowidOf('b1'), 'html', GENERATION, 7);
    await reader.openInReader(rowidOf('b1'), 'plain');
    expect(pev.open).toHaveBeenLastCalledWith(rowidOf('b1'), 'plain', GENERATION, 7);

    // Leaving search drops it: any later open goes without it, a row of the folder's list too.
    mailbox.clearSearch();
    await reader.openInReader(rowidOf('b0'));
    expect(pev.open).toHaveBeenLastCalledWith(rowidOf('b0'), 'html', GENERATION);
    mailbox.selectRow({ threadId: threadOf('s0'), newestRowid: rowidOf('s0') } as Row);
    await flush();
    expect(pev.open).toHaveBeenLastCalledWith(rowidOf('s0'), 'html', GENERATION);
    expect(reader.getReaderState().queryId).toBeNull();
  });
});

describe('cards no result opened', () => {
  it('stay when the results go', async () => {
    setup();
    mailbox.selectRow({ threadId: threadOf('solo'), newestRowid: rowidOf('solo') } as Row);
    await flush();
    page = resultFor('s0');
    await searchFor('small');

    mailbox.clearSearch();
    expect(mailbox.cards.snapshot).toMatchObject({
      shown: true,
      threadId: threadOf('solo'),
      expanded: rowidOf('solo'),
    });
    expect(reader.getReaderState().rowid).toBe(rowidOf('solo'));
    expect(pev.closeView).not.toHaveBeenCalled();
  });

  it('stay when the results go after a result had opened cards that were since replaced', async () => {
    setup();
    page = resultFor('s0');
    await searchFor('small');
    mailbox.selectResult(mailbox.search.snapshot.rows[0]!);
    await flush();
    // Another conversation replaces the result's cards, as a new showing.
    mailbox.cards.show(rowidOf('solo'), threadOf('solo'));
    await flush();

    mailbox.clearSearch();
    expect(mailbox.cards.snapshot).toMatchObject({ shown: true, threadId: threadOf('solo') });
    expect(reader.getReaderState().rowid).toBe(rowidOf('solo'));
  });
});
