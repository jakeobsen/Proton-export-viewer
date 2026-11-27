// SPDX-License-Identifier: AGPL-3.0-or-later
// The search box's model in the shell: one search per typing pause, only the
// latest answer shown, pages read as the view nears the end, conversations
// already shown left out of later pages, and the texts the results show.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchRequest, SnippetsRequest } from '../../src/shared/api';
import type {
  SearchKey,
  SearchPage,
  SearchSort,
  ThreadSnippet,
} from '../../src/shared/index-types';
import {
  RESULTS_MARGIN,
  SearchModel,
  TYPING_PAUSE_MS,
  conversationsText,
  partialText,
  snippetParts,
} from '../../src/renderer/search';

interface Call {
  request: SearchRequest;
  resolve: (page: SearchPage | null) => void;
  reject: (err: unknown) => void;
}

/** Search requests as they are made, each answered when the test says. */
class Runner {
  calls: Call[] = [];
  run = (request: SearchRequest): Promise<SearchPage | null> =>
    new Promise((resolve, reject) => this.calls.push({ request, resolve, reject }));
  get last(): Call {
    return this.calls.at(-1)!;
  }
}

interface SnippetCall {
  request: SnippetsRequest;
  resolve: (snippets: ThreadSnippet[] | null) => void;
}

/** Snippet requests as they are made. */
class SnippetRunner {
  calls: SnippetCall[] = [];
  run = (request: SnippetsRequest): Promise<ThreadSnippet[] | null> =>
    new Promise((resolve) => this.calls.push({ request, resolve }));
  get last(): SnippetCall {
    return this.calls.at(-1)!;
  }
}

interface PageOptions {
  queryId?: number;
  sort?: SearchSort;
  ranked?: boolean;
  total?: number | null;
  next?: SearchKey | null;
  pending?: number;
}

function page(threadIds: number[], options: PageOptions = {}): SearchPage {
  return {
    queryId: options.queryId ?? 1,
    sort: options.sort ?? 'date',
    ranked: options.ranked ?? true,
    total: options.total ?? null,
    rows: threadIds.map((threadId) => ({
      threadId,
      time: 1000 - threadId,
      rank: null,
      count: 1,
      unread: 0,
      attachments: false,
      matching: 1,
      anchorRowid: threadId * 10,
      snippet: null,
    })),
    details: threadIds.map((threadId) => ({
      threadId,
      subject: `s${threadId}`,
      participants: [],
      labelIds: [],
    })),
    next: options.next ?? null,
    coverage: { indexed: 0, pending: options.pending ?? 0, total: 10 },
    dropped: 0,
  };
}

const range = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i);
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

let runner: Runner;
let snippetRunner: SnippetRunner;
let changes: number;
let model: SearchModel;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  runner = new Runner();
  snippetRunner = new SnippetRunner();
  changes = 0;
  model = new SearchModel(runner.run, snippetRunner.run, () => {
    changes += 1;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Types text and lets the pause pass, so the search starts. */
function typeAndPause(text: string): void {
  model.setText(text);
  vi.advanceTimersByTime(TYPING_PAUSE_MS);
}

async function answer(call: Call, result: SearchPage | null): Promise<void> {
  call.resolve(result);
  await flush();
}

describe('typing', () => {
  it('searches once typing pauses, with the latest text', () => {
    model.setText('z');
    vi.advanceTimersByTime(100);
    model.setText('ze');
    vi.advanceTimersByTime(100);
    model.setText('zeb');
    vi.advanceTimersByTime(TYPING_PAUSE_MS - 1);
    expect(runner.calls).toHaveLength(0);
    expect(model.snapshot.active).toBe(false);
    vi.advanceTimersByTime(1);
    expect(runner.calls.map((c) => c.request)).toEqual([
      { text: 'zeb', sort: 'date', after: null },
    ]);
    expect(model.snapshot).toMatchObject({ text: 'zeb', active: true, searching: true });
  });

  it('an emptied box shows the list again at once, and the waiting search never runs', async () => {
    typeAndPause('zebra');
    await answer(runner.last, page([1, 2], { total: 2 }));
    expect(model.snapshot).toMatchObject({ active: true, total: 2 });
    model.setText('zebras');
    model.setText('   ');
    expect(model.snapshot).toMatchObject({ text: '   ', active: false, rows: [], total: null });
    vi.advanceTimersByTime(TYPING_PAUSE_MS * 3);
    expect(runner.calls).toHaveLength(1);
  });

  it('clearing drops the results, and an answer that comes after installs nothing', async () => {
    typeAndPause('zebra');
    const pending = runner.last;
    model.clear();
    await answer(pending, page([1], { total: 1 }));
    expect(model.snapshot).toMatchObject({ text: '', active: false, rows: [], searching: false });
  });

  it('another sort runs the search again at once, but only with text in the box', () => {
    model.setSort('relevance');
    expect(runner.calls).toHaveLength(0);
    model.setText('zebra');
    model.setSort('date');
    expect(runner.calls.map((c) => c.request)).toEqual([
      { text: 'zebra', sort: 'date', after: null },
    ]);
    // The pause that was running doesn't search a second time.
    vi.advanceTimersByTime(TYPING_PAUSE_MS);
    expect(runner.calls).toHaveLength(1);
  });
});

describe('answers', () => {
  it('only the latest search installs, whichever answer comes first', async () => {
    typeAndPause('zeb');
    const older = runner.last;
    typeAndPause('zebra');
    const newer = runner.last;
    await answer(newer, page([7, 8], { total: 2 }));
    await answer(older, page([1, 2, 3], { total: 3 }));
    expect(model.snapshot.rows.map((r) => r.threadId)).toEqual([7, 8]);
    expect(model.snapshot.total).toBe(2);

    typeAndPause('zebras');
    const third = runner.last;
    typeAndPause('zebrass');
    await answer(third, page([4], { total: 1 }));
    // The older answer came first and was dropped; the shown results stay until the newer one.
    expect(model.snapshot.rows.map((r) => r.threadId)).toEqual([7, 8]);
    expect(model.snapshot.searching).toBe(true);
    await answer(runner.last, page([5], { total: 1 }));
    expect(model.snapshot.rows.map((r) => r.threadId)).toEqual([5]);
  });

  it('gives each row its details, and starts each new search at the top', async () => {
    typeAndPause('zebra');
    await answer(runner.last, page([3, 4], { total: 2 }));
    expect(model.snapshot.rows.map((r) => r.details?.subject)).toEqual(['s3', 's4']);
    const shown = model.snapshot.shownId;
    typeAndPause('zebras');
    await answer(runner.last, page([5], { total: 1 }));
    expect(model.snapshot.shownId).toBe(shown + 1);
  });

  it('a search that gets no answer shows no rows, and none count as a result', async () => {
    typeAndPause('zebra');
    await answer(runner.last, page([1], { total: 1 }));
    typeAndPause('zebras');
    await answer(runner.last, null);
    expect(model.snapshot).toMatchObject({ failed: true, searching: false, rows: [], total: null });
    typeAndPause('zebrass');
    runner.last.reject(new Error('gone'));
    await flush();
    expect(model.snapshot.failed).toBe(true);
  });
});

describe('pages', () => {
  const dateKey = (threadId: number): SearchKey => ({ time: 1000 - threadId, threadId });

  it('reads the next page when the view nears the end, from the keyset core gave', async () => {
    typeAndPause('zebra');
    await answer(runner.last, page(range(1, 200), { total: 260, next: dateKey(200) }));
    model.setViewport(200 - RESULTS_MARGIN - 1, 200 - RESULTS_MARGIN - 1);
    expect(runner.calls).toHaveLength(1);
    model.setViewport(200 - RESULTS_MARGIN, 200 - RESULTS_MARGIN);
    expect(runner.last.request).toEqual({ text: 'zebra', sort: 'date', after: dateKey(200) });
    // One page at a time.
    model.setViewport(199, 199);
    expect(runner.calls).toHaveLength(2);
    await answer(runner.last, page(range(201, 60)));
    expect(model.snapshot.rows).toHaveLength(260);
    // Its count stays the first page's.
    expect(model.snapshot.total).toBe(260);
    model.setViewport(259, 259);
    expect(runner.calls).toHaveLength(2);
  });

  for (const sort of ['date', 'relevance'] as const) {
    it(`by ${sort}, leaves out conversations already shown and continues after core's last row`, async () => {
      model.setSort(sort);
      typeAndPause('zebra');
      const key = (threadId: number): SearchKey =>
        sort === 'date' ? dateKey(threadId) : { rank: -threadId, threadId };
      await answer(runner.last, page(range(1, 200), { sort, next: key(200) }));
      model.setViewport(199, 199);
      // A conversation from the first page comes again, last.
      await answer(runner.last, page([201, 202, 5], { sort, next: key(5) }));
      expect(model.snapshot.rows.map((r) => r.threadId)).toEqual([...range(1, 202)]);
      expect(model.snapshot.skipped).toBe(1);
      model.setViewport(201, 201);
      expect(runner.last.request).toEqual({ text: 'zebra', sort, after: key(5) });
    });
  }

  it('a page made only of conversations already shown still moves on', async () => {
    typeAndPause('zebra');
    await answer(runner.last, page(range(1, 200), { next: dateKey(200) }));
    model.setViewport(199, 199);
    await answer(runner.last, page(range(1, 200), { next: dateKey(400) }));
    expect(model.snapshot.rows).toHaveLength(200);
    expect(model.snapshot.skipped).toBe(200);
    // Nothing new to show, so the next page is read straight away, after the last row returned.
    expect(runner.calls).toHaveLength(3);
    expect(runner.last.request).toEqual({ text: 'zebra', sort: 'date', after: dateKey(400) });
    await answer(runner.last, page([401]));
    expect(model.snapshot.rows.at(-1)!.threadId).toBe(401);
  });

  it('continues a query sorted by date by date, though relevance was asked', async () => {
    model.setSort('relevance');
    typeAndPause('is:unread');
    expect(runner.last.request.sort).toBe('relevance');
    await answer(
      runner.last,
      page(range(1, 200), { sort: 'date', ranked: false, next: dateKey(200) }),
    );
    expect(model.snapshot.ranked).toBe(false);
    model.setViewport(199, 199);
    expect(runner.last.request).toEqual({ text: 'is:unread', sort: 'date', after: dateKey(200) });
  });

  it('a later page without an answer is read again on the next scroll', async () => {
    typeAndPause('zebra');
    await answer(runner.last, page(range(1, 200), { next: dateKey(200) }));
    model.setViewport(199, 199);
    await answer(runner.last, null);
    expect(model.snapshot.rows).toHaveLength(200);
    expect(runner.calls).toHaveLength(2);
    model.setViewport(199, 199);
    expect(runner.calls).toHaveLength(3);
    expect(runner.last.request.after).toEqual(dateKey(200));
  });

  it('a page of an older search installs nothing, and a new search may read its own pages', async () => {
    typeAndPause('zebra');
    await answer(runner.last, page(range(1, 200), { next: dateKey(200) }));
    model.setViewport(199, 199);
    const late = runner.last;
    typeAndPause('zebras');
    await answer(runner.last, page(range(301, 200), { next: dateKey(500) }));
    await answer(late, page([201]));
    expect(model.snapshot.rows.map((r) => r.threadId)).not.toContain(201);
    model.setViewport(199, 199);
    expect(runner.last.request).toEqual({ text: 'zebras', sort: 'date', after: dateKey(500) });
  });

  it('keeps the coverage of the latest page', async () => {
    typeAndPause('zebra');
    await answer(runner.last, page(range(1, 200), { next: dateKey(200), pending: 9 }));
    expect(model.snapshot.coverage?.pending).toBe(9);
    model.setViewport(199, 199);
    await answer(runner.last, page([201], { pending: 4 }));
    expect(model.snapshot.coverage?.pending).toBe(4);
    expect(changes).toBeGreaterThan(0);
  });
});

describe('snippets past the first rows', () => {
  const marked = (threadId: number): ThreadSnippet => ({
    threadId,
    snippet: { text: `zebra ${threadId}`, ranges: [[0, 5]] },
  });

  it('rows on screen without one get theirs, for the shown search, at most 50 a request', async () => {
    model.setViewport(0, 9);
    typeAndPause('zebra');
    await answer(runner.last, page(range(1, 200), { queryId: 7 }));
    // The rows on screen when the results come are asked for at once.
    expect(snippetRunner.last.request).toEqual({ queryId: 7, threadIds: range(1, 10) });
    snippetRunner.last.resolve(null);
    await flush();
    model.setViewport(60, 120);
    expect(snippetRunner.last.request).toEqual({ queryId: 7, threadIds: range(61, 50) });
    snippetRunner.last.resolve([...range(61, 49).map(marked), { threadId: 110, snippet: null }]);
    await flush();
    expect(model.snapshot.rows[60]!.snippet).toEqual(marked(61).snippet);
    expect(model.snapshot.rows[109]!.snippet).toBeNull();
    // Then the rest on screen, and only those.
    expect(snippetRunner.last.request).toEqual({ queryId: 7, threadIds: range(111, 11) });
    snippetRunner.last.resolve(range(111, 11).map(marked));
    await flush();
    // Each conversation is asked for once, whatever the answer was.
    const calls = snippetRunner.calls.length;
    model.setViewport(60, 120);
    expect(snippetRunner.calls).toHaveLength(calls);
  });

  it('without an answer, the next change of view asks again', async () => {
    model.setViewport(0, 3);
    typeAndPause('zebra');
    await answer(runner.last, page(range(1, 100), { queryId: 3 }));
    snippetRunner.last.resolve(null);
    await flush();
    expect(snippetRunner.calls).toHaveLength(1);
    model.setViewport(0, 5);
    expect(snippetRunner.calls).toHaveLength(2);
    expect(snippetRunner.last.request.threadIds).toEqual(range(1, 6));
  });

  it('a row that came with one, or a query with no words, asks for none', async () => {
    model.setViewport(0, 9);
    typeAndPause('zebra');
    const first = page([1, 2]);
    first.rows[0]!.snippet = { text: 'zebra', ranges: [[0, 5]] };
    await answer(runner.last, first);
    expect(snippetRunner.last.request.threadIds).toEqual([2]);
    typeAndPause('is:unread');
    await answer(runner.last, page([1, 2], { ranked: false }));
    model.setViewport(0, 1);
    expect(snippetRunner.calls).toHaveLength(1);
  });

  it('snippets for an older search install nothing, and a later page names its own query ID', async () => {
    model.setViewport(0, 9);
    typeAndPause('zebra');
    await answer(runner.last, page([1, 2], { queryId: 1 }));
    const late = snippetRunner.last;
    typeAndPause('zebras');
    await answer(runner.last, page([1, 2], { queryId: 2, next: { time: 1, threadId: 2 } }));
    late.resolve([marked(1)]);
    await flush();
    expect(model.snapshot.rows[0]!.snippet).toBeNull();
    expect(snippetRunner.last.request).toEqual({ queryId: 2, threadIds: [1, 2] });
    snippetRunner.last.resolve(null);
    await flush();
    await answer(runner.last, page([3], { queryId: 5 }));
    model.setViewport(0, 2);
    expect(snippetRunner.last.request.queryId).toBe(5);
  });
});

describe('selection', () => {
  it('holds the result and the message it opens', async () => {
    typeAndPause('zebra');
    await answer(runner.last, page([3, 4]));
    model.select(model.rowAt(1)!);
    expect(model.snapshot.selected).toEqual({ threadId: 4, rowid: 40 });
    expect(model.selectedIndex()).toBe(1);
    model.clear();
    expect(model.snapshot.selected).toBeNull();
  });
});

describe('texts', () => {
  it('snippets are text with marked parts; bad ranges give the text unmarked', () => {
    expect(snippetParts({ text: 'a <b>zebra</b> b', ranges: [[5, 10]] })).toEqual([
      { text: 'a <b>', mark: false },
      { text: 'zebra', mark: true },
      { text: '</b> b', mark: false },
    ]);
    // UTF-16 units: the emoji takes two.
    expect(snippetParts({ text: '😀 zebra', ranges: [[3, 8]] })).toEqual([
      { text: '😀 ', mark: false },
      { text: 'zebra', mark: true },
    ]);
    expect(snippetParts({ text: 'zebra', ranges: [] })).toEqual([{ text: 'zebra', mark: false }]);
    const bad: Array<Array<[number, number]>> = [
      [[2, 1]],
      [
        [0, 3],
        [2, 4],
      ],
      [[0, 6]],
      [[-1, 2]],
      [[0.5, 2]],
      [[Number.NaN, 2]],
      [[3, 3]],
    ];
    for (const ranges of bad) {
      expect(snippetParts({ text: 'zebra', ranges })).toEqual([{ text: 'zebra', mark: false }]);
    }
    expect(snippetParts({ text: '', ranges: [[0, 1]] })).toEqual([]);
  });

  it('counts conversations, and shows the partial line only while bodies wait', () => {
    expect(conversationsText(1)).toBe('1 conversation');
    expect(conversationsText(1200)).toBe('1,200 conversations');
    expect(partialText(null)).toBeNull();
    expect(partialText({ indexed: 152_000, pending: 0, total: 152_000 })).toBeNull();
    // A body that couldn't be read isn't waiting.
    expect(partialText({ indexed: 151_990, pending: 0, total: 152_000 })).toBeNull();
    expect(partialText({ indexed: 61_000, pending: 91_000, total: 152_000 })).toBe(
      'Partial results: 61,000 of 152,000 bodies indexed.',
    );
  });
});
