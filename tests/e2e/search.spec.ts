// SPDX-License-Identifier: AGPL-3.0-or-later
// Search through the app: the shell's request reaches the open export's index
// in core and comes back as a page of conversations. Main takes only the text,
// the sort and the keyset, for the current generation.

import { realpathSync } from 'node:fs';
import type { SearchResult } from '../../src/shared/api';
import type {
  IndexProgress,
  IndexTotals,
  ListPage,
  RowDetails,
} from '../../src/shared/index-types';
import { writeExport } from '../exports';
import { testDir } from '../paths';
import { expect, test, type PevApp } from './app';

type Answer<T> = { answer: T; progress: IndexProgress } | null;
const ask = <T>(pev: PevApp, query: unknown) => pev.main<Answer<T>>('indexQuery', query);

const invoke = (pev: PevApp, ...args: unknown[]) =>
  pev.page.evaluate(
    (a) => window.__pevTestIpc.invoke('pev:search', ...a),
    args,
  ) as Promise<SearchResult>;
const search = (pev: PevApp, request: unknown, generation: number) =>
  pev.page.evaluate(
    ([r, g]) => window.pev.search(r as Parameters<typeof window.pev.search>[0], g),
    [request, generation] as const,
  );

async function openExport(pev: PevApp, name: string): Promise<number> {
  const root = realpathSync(testDir(name));
  const written = writeExport(root, { seed: 21, messages: 30 });
  await pev.main('queuePick', root, 'bm1');
  await pev.shell('chooseFolder', []);
  await expect
    .poll(async () => (await ask<IndexTotals>(pev, { op: 'totals' }))?.progress, {
      timeout: 20_000,
    })
    .toMatchObject({ phase: 'done', loaded: written.pairs, total: written.pairs });
  // Then phase 2: the text of every message file.
  await expect
    .poll(async () => (await ask<IndexTotals>(pev, { op: 'totals' }))?.progress, {
      timeout: 20_000,
    })
    .toMatchObject({ bodyPhase: 'done', bodiesDone: written.pairs, bodiesTotal: written.pairs });
  const state = await pev.page.evaluate(() => window.pev.state());
  if (!state.ok) throw new Error('no generation');
  return state.generation;
}

test('the search channel takes the text, the sort and its keyset, for the current generation', async ({
  pev,
}) => {
  const invalid = { ok: false, code: 'invalid' };
  const ok = { text: 'x', chips: [], sort: 'date', after: null, generation: 1 };
  expect(await invoke(pev, { text: 'x', sort: 'date', after: null, generation: 1 })).toEqual(
    invalid,
  );
  expect(await invoke(pev, { ...ok, chips: [{ k: 'unread', extra: 1 }] })).toEqual(invalid);
  expect(await invoke(pev, { ...ok, text: 'x'.repeat(1001) })).toEqual(invalid);
  expect(await invoke(pev, { ...ok, extra: 1 })).toEqual(invalid);
  expect(await invoke(pev, { ...ok, sort: 'size' })).toEqual(invalid);
  expect(await invoke(pev, { ...ok, after: { rank: 1, threadId: 2 } })).toEqual(invalid);
  expect(await invoke(pev, { ...ok, sort: 'relevance', after: { time: 1, threadId: 2 } })).toEqual(
    invalid,
  );
  for (const rank of [Number.NaN, Infinity, '1']) {
    expect(await invoke(pev, { ...ok, sort: 'relevance', after: { rank, threadId: 2 } })).toEqual(
      invalid,
    );
  }
  expect(await invoke(pev, { ...ok, after: { time: 1.5, threadId: 2 } })).toEqual(invalid);
  expect(await invoke(pev, { ...ok, after: { time: 1, threadId: 0 } })).toEqual(invalid);
  expect(await invoke(pev, { ...ok, text: 42 })).toEqual(invalid);
  expect(await invoke(pev, ok, 'extra')).toEqual(invalid);
  expect(await invoke(pev, { ...ok, generation: 99 })).toEqual({
    ok: false,
    code: 'stale_generation',
  });
  // Before an export is open there is nothing to search.
  expect(await invoke(pev, ok)).toEqual({ ok: false, code: 'no_source' });
  expect(await invoke(pev, { ...ok, text: 'x'.repeat(1000) })).toEqual({
    ok: false,
    code: 'no_source',
  });
});

test('a search gives a page of the open export, by date and by relevance', async ({ pev }) => {
  const generation = await openExport(pev, 'search-open');
  // The newest conversation's subject, as the list shows it.
  const list = (await ask<ListPage>(pev, { op: 'page', labelId: '5', after: null }))!.answer;
  const newest = list.rows[0]!;
  const details = (await ask<RowDetails[]>(pev, { op: 'details', threadIds: [newest.threadId] }))!
    .answer[0]!;
  const word = details.subject.split(/[^\p{L}\p{N}]+/u).find((w) => w.length >= 3);
  expect(word).toBeDefined();

  const byDate = await search(pev, { text: word, sort: 'date', after: null }, generation);
  expect(byDate).toMatchObject({ ok: true, generation });
  if (!byDate.ok) throw new Error('search failed');
  expect(byDate.page.sort).toBe('date');
  expect(byDate.page.queryId).toBe(byDate.queryId);
  expect(byDate.page.rows.map((r) => r.threadId)).toContain(newest.threadId);
  expect(byDate.page.coverage).toEqual({ indexed: 30, pending: 0, total: 30 });
  expect(byDate.page.total).toBe(byDate.page.rows.length);
  expect(byDate.page.details.map((d) => d.threadId)).toEqual(
    byDate.page.rows.map((r) => r.threadId),
  );
  expect(byDate.progress.phase).toBe('done');
  const row = byDate.page.rows.find((r) => r.threadId === newest.threadId)!;
  expect(row.matching).toBeGreaterThan(0);
  expect(row.snippet?.ranges.length).toBeGreaterThan(0);

  const byRank = await search(pev, { text: word, sort: 'relevance', after: null }, generation);
  if (!byRank.ok) throw new Error('search failed');
  expect(byRank.page.sort).toBe('relevance');
  expect(byRank.queryId).toBeGreaterThan(byDate.queryId);
  expect(new Set(byRank.page.rows.map((r) => r.threadId))).toEqual(
    new Set(byDate.page.rows.map((r) => r.threadId)),
  );

  // Filters only: by date, whatever was asked.
  const filters = await search(
    pev,
    { text: 'folder:"all mail"', sort: 'relevance', after: null },
    generation,
  );
  if (!filters.ok) throw new Error('search failed');
  expect(filters.page.sort).toBe('date');
  expect(filters.page.rows.length).toBe(list.rows.length);

  // A search made for an old generation is refused.
  expect(await search(pev, { text: word, sort: 'date', after: null }, generation - 1)).toEqual({
    ok: false,
    code: 'stale_generation',
  });
  // No query text reaches a log.
  expect(JSON.stringify(pev.logs('main'))).not.toContain(word);
  expect(JSON.stringify(pev.logs('core'))).not.toContain(word);
});
