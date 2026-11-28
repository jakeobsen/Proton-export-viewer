// SPDX-License-Identifier: AGPL-3.0-or-later
// Search chips and recent searches in main's IPC: a search's chips are
// checked, a commit names a query ID and main records the search it ran under
// that ID, and any change of the text or the chips makes a new search whose
// older IDs no longer name it.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IndexQuery } from '../../src/shared/index-types';
import { searchKey } from '../../src/shared/search-chips';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const fake = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => fake.handlers.set(channel, fn),
    on: () => {},
  },
  shell: { showItemInFolder: () => {}, openExternal: () => Promise.resolve() },
  clipboard: { writeText: () => {} },
  app: {},
  dialog: {},
  protocol: {},
  session: {},
  BrowserWindow: class {},
  MessageChannelMain: class {},
  utilityProcess: {},
}));

const { registerIpc } = await import('../../src/main/ipc');
const { STALE } = await import('../../src/main/sources/manager');
const { IPC } = await import('../../src/shared/api');
type AppContext = import('../../src/main/context').AppContext;
type AppWindow = import('../../src/main/context').AppWindow;

const SOURCE = '00000000-0000-4000-8000-0000000000bb';

function make(answers: { keep?: unknown; clear?: unknown } = {}) {
  const frame = { processId: 4, frameToken: 'main-frame', origin: 'app://shell' };
  const appWin = {
    id: 3,
    win: { isDestroyed: () => false, webContents: { send() {} } },
    session: {},
  } as unknown as AppWindow;
  const queries: IndexQuery[] = [];
  const recorded: Array<[string, number]> = [];
  const asked: unknown[][] = [];
  const ctx = {
    generation: 7,
    windows: new Map([[11, appWin]]),
    log: { error() {}, warn() {}, info() {} },
    sources: {
      queryIndex: async (query: IndexQuery) => {
        queries.push(query);
        const queryId = 'queryId' in query ? query.queryId : 0;
        return {
          answer:
            query.op === 'snippets'
              ? { queryId, snippets: [], dropped: 0 }
              : { queryId, rows: [], details: [], total: 0, next: null },
          progress: {},
        };
      },
      recordSearch: (q: string, at: number) => recorded.push([q, at]),
      recentSearches: async () => [{ text: 'old', chips: [] }],
      setKeepRecent: (...args: unknown[]) => {
        asked.push(['keep', ...args]);
        return answers.keep ?? true;
      },
      clearRecent: async (...args: unknown[]) => {
        asked.push(['clear', ...args]);
        return answers.clear ?? 'ok';
      },
    },
  } as unknown as AppContext;
  fake.handlers.clear();
  registerIpc(ctx);
  const event = { sender: { id: 11, mainFrame: frame }, senderFrame: frame };
  const call = (channel: string, args: unknown) =>
    (fake.handlers.get(channel) as Handler)(event, args) as Promise<Record<string, unknown>>;
  const search = async (text: string, chips: unknown[] = [], generation = 7) =>
    call(IPC.search, { text, chips, sort: 'date', after: null, generation });
  const commit = (queryId: number, generation = 7) =>
    call(IPC.commitSearch, { queryId, generation });
  const snippets = (queryId: number) =>
    call(IPC.searchSnippets, { queryId, threadIds: [1], generation: 7 });
  return { ctx, queries, recorded, asked, call, search, commit, snippets };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('a search with chips', () => {
  it('goes to core with its chips in canonical order', async () => {
    const t = make();
    const result = await t.search('budget', [{ k: 'unread' }, { k: 'from', v: ' alice ' }]);
    expect(result.ok).toBe(true);
    expect(t.queries[0]).toMatchObject({
      op: 'search',
      text: 'budget',
      chips: [{ k: 'from', v: 'alice' }, { k: 'unread' }],
    });
  });

  it('is refused whole when one chip is bad, before core is asked', async () => {
    const t = make();
    for (const chips of [
      [{ k: 'from', v: '!!!' }],
      [{ k: 'after', d: '2023-02-29' }],
      [{ k: 'label', id: '' }],
      [{ k: 'unread' }, { k: 'unread' }],
      Array.from({ length: 9 }, (_, i) => ({ k: 'label', id: `l${i}` })),
      'unread',
    ]) {
      expect(await t.search('x', chips as unknown[]), JSON.stringify(chips)).toEqual({
        ok: false,
        code: 'invalid',
      });
    }
    expect(
      await t.call(IPC.search, { text: 'x', sort: 'date', after: null, generation: 7 }),
    ).toEqual({ ok: false, code: 'invalid' });
    expect(t.queries).toEqual([]);
  });

  it('starts a new search when a chip is added to the same text: the older ID is refused', async () => {
    const t = make();
    const first = (await t.search('budget')).queryId as number;
    const again = (await t.search('budget ')).queryId as number;
    // The same search, as its canonical form: its first ID still names it.
    expect(await t.snippets(first)).toMatchObject({ ok: true });
    const chipped = (await t.search('budget', [{ k: 'unread' }])).queryId as number;
    expect(await t.snippets(first)).toEqual({ ok: false, code: 'superseded' });
    expect(await t.snippets(again)).toEqual({ ok: false, code: 'superseded' });
    expect(await t.commit(first)).toEqual({ ok: false, code: 'superseded' });
    expect(t.recorded).toEqual([]);
    expect(await t.snippets(chipped)).toMatchObject({ ok: true });
    expect(t.queries.at(-1)).toMatchObject({
      op: 'snippets',
      text: 'budget',
      chips: [{ k: 'unread' }],
    });
  });
});

describe('a committed search', () => {
  it('records what main ran under that ID, at the time main received it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_700_000_000_000);
    const t = make();
    const id = (await t.search('  invoice  march', [{ k: 'label', id: 'l1' }])).queryId as number;
    expect(await t.commit(id)).toEqual({ ok: true, generation: 7 });
    expect(t.recorded).toEqual([
      [searchKey({ text: 'invoice march', chips: [{ k: 'label', id: 'l1' }] }), 1_700_000_000_000],
    ]);
  });

  it('is refused for another generation, an unknown ID, or a bad request', async () => {
    const t = make();
    const id = (await t.search('invoice')).queryId as number;
    expect(await t.commit(id, 6)).toEqual({ ok: false, code: 'stale_generation' });
    expect(await t.commit(id + 50)).toEqual({ ok: false, code: 'superseded' });
    expect(await t.call(IPC.commitSearch, { queryId: id, generation: 7, text: 'x' })).toEqual({
      ok: false,
      code: 'invalid',
    });
    expect(await t.call(IPC.commitSearch, { queryId: id })).toEqual({ ok: false, code: 'invalid' });
    expect(t.recorded).toEqual([]);
  });

  it('records nothing for an empty search', async () => {
    const t = make();
    const id = (await t.search('   ')).queryId as number;
    expect(await t.commit(id)).toEqual({ ok: true, generation: 7 });
    expect(t.recorded).toEqual([]);
  });
});

describe("Settings' recent-search actions", () => {
  it('reach the manager with the export and generation Settings showed', async () => {
    const t = make();
    expect(await t.call(IPC.keepRecent, { sourceKey: SOURCE, keep: false, generation: 7 })).toEqual(
      { ok: true, generation: 7 },
    );
    expect(await t.call(IPC.clearRecent, { sourceKey: SOURCE, generation: 7 })).toEqual({
      ok: true,
      generation: 7,
    });
    expect(t.asked).toEqual([
      ['keep', SOURCE, false, 7],
      ['clear', SOURCE, 7],
    ]);
  });

  it('are refused as stale, changing nothing, for another generation', async () => {
    const t = make();
    expect(await t.call(IPC.keepRecent, { sourceKey: SOURCE, keep: false, generation: 6 })).toEqual(
      { ok: false, code: 'stale_generation' },
    );
    expect(await t.call(IPC.clearRecent, { sourceKey: SOURCE, generation: 6 })).toEqual({
      ok: false,
      code: 'stale_generation',
    });
    expect(t.asked).toEqual([]);
  });

  it("answer the manager's stale and failed outcomes", async () => {
    const stale = make({ keep: STALE, clear: STALE });
    expect(
      await stale.call(IPC.keepRecent, { sourceKey: SOURCE, keep: true, generation: 7 }),
    ).toEqual({ ok: false, code: 'stale_generation' });
    expect(await stale.call(IPC.clearRecent, { sourceKey: SOURCE, generation: 7 })).toEqual({
      ok: false,
      code: 'stale_generation',
    });
    const failed = make({ clear: 'failed' });
    expect(await failed.call(IPC.clearRecent, { sourceKey: SOURCE, generation: 7 })).toEqual({
      ok: false,
      code: 'core_unavailable',
    });
  });

  it('list the recent searches for the current generation only', async () => {
    const t = make();
    expect(await t.call(IPC.recentSearches, { generation: 7 })).toEqual({
      ok: true,
      generation: 7,
      entries: [{ text: 'old', chips: [] }],
    });
    expect(await t.call(IPC.recentSearches, { generation: 6 })).toEqual({
      ok: false,
      code: 'stale_generation',
    });
  });
});
