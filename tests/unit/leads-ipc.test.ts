// SPDX-License-Identifier: AGPL-3.0-or-later
// Lead lines and the cards of a conversation opened from a search, in main:
// strict arguments from the shell's own frame for the current generation;
// the search named by its query ID, with main putting in its text (an older
// or unknown one gives plain lines and plain cards); and one request in core
// per window, with a waiting place for the list and one for the cards.

import { describe, expect, it, vi } from 'vitest';
import type { IndexQuery } from '../../src/shared/index-types';

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
const { ViewRegistry } = await import('../../src/main/views');
type AppContext = import('../../src/main/context').AppContext;
type AppWindow = import('../../src/main/context').AppWindow;

const LEADS = 'pev:leads';
const INDEX = 'pev:index';
const SEARCH = 'pev:search';
const PROGRESS = { phase: 'done' };

function make() {
  const frame = { processId: 4, frameToken: 'main-frame', origin: 'app://shell' };
  const other = { processId: 4, frameToken: 'sub-frame', origin: 'app://shell' };
  const appWin = {
    id: 3,
    win: { isDestroyed: () => false, webContents: { send() {} } },
    views: new ViewRegistry(),
    session: {},
  } as unknown as AppWindow;
  const queries: IndexQuery[] = [];
  /** Core's answers wait while held; each waiting one is let go in turn. */
  const held: Array<() => void> = [];
  let holding = false;
  const answerOf = (query: IndexQuery) => {
    switch (query.op) {
      case 'search':
        return { queryId: query.queryId, rows: [], total: 0 };
      case 'leads':
        return {
          leads: query.rowids.map((rowid) => ({ rowid, text: `lead ${rowid}`, snippet: null })),
          dropped: 0,
        };
      default:
        return { threadId: 1, cards: [], total: 0, rev: 1, searched: false };
    }
  };
  const ctx = {
    generation: 1,
    windows: new Map([[11, appWin]]),
    log: { error: () => {}, warn: () => {}, info: () => {} },
    sources: {
      queryIndex: async (query: IndexQuery) => {
        queries.push(query);
        if (holding) await new Promise<void>((resolve) => held.push(resolve));
        return { answer: answerOf(query), progress: PROGRESS };
      },
    },
  } as unknown as AppContext;
  fake.handlers.clear();
  registerIpc(ctx);
  const event = { sender: { id: 11, mainFrame: frame }, senderFrame: frame };
  const call = (channel: string, ...args: unknown[]) =>
    (fake.handlers.get(channel) as Handler)(event, ...args);
  const callFrom = (senderFrame: unknown, channel: string, ...args: unknown[]) =>
    (fake.handlers.get(channel) as Handler)({ sender: event.sender, senderFrame }, ...args);
  /** Searches as the box does; resolves to the query ID main gave it. */
  const search = async (text: string) => {
    const result = (await call(SEARCH, { text, sort: 'date', after: null, generation: 1 })) as {
      queryId: number;
    };
    return result.queryId;
  };
  return {
    ctx,
    queries,
    call,
    callFrom,
    other,
    search,
    hold: () => (holding = true),
    release: async () => {
      holding = false;
      while (held.length > 0) {
        held.shift()!();
        await new Promise((r) => setTimeout(r, 0));
      }
    },
  };
}

const cardsQuery = (search?: unknown) => ({
  op: 'cards',
  follow: [5],
  threadId: 2,
  anchor: { rowid: 5, index: 0 },
  before: 10,
  after: 20,
  ...(search === undefined ? {} : { search }),
});

describe('lead lines in main', () => {
  it('reads the lines of the messages asked for, with no search unless one is named', async () => {
    const t = make();
    expect(await t.call(LEADS, { requester: 'list', rowids: [5, 6], generation: 1 })).toEqual({
      ok: true,
      generation: 1,
      leads: [
        { rowid: 5, text: 'lead 5', snippet: null },
        { rowid: 6, text: 'lead 6', snippet: null },
      ],
    });
    expect(t.queries).toEqual([{ op: 'leads', rowids: [5, 6] }]);
  });

  it('refuses another frame, bad arguments and a stale generation, and asks core nothing', async () => {
    const t = make();
    expect(
      await t.callFrom(t.other, LEADS, { requester: 'list', rowids: [5], generation: 1 }),
    ).toEqual({ ok: false, code: 'not_main_frame' });
    const bad = [
      { requester: 'list', rowids: [], generation: 1 },
      { requester: 'list', rowids: Array.from({ length: 51 }, (_, i) => i + 1), generation: 1 },
      { requester: 'list', rowids: [0], generation: 1 },
      { requester: 'search', rowids: [5], generation: 1 },
      { requester: 'cards', rowids: [5], queryId: 1, text: 'invoice', generation: 1 },
      { requester: 'cards', rowids: [5], queryId: 0, generation: 1 },
    ];
    for (const args of bad) {
      expect(await t.call(LEADS, args), JSON.stringify(args)).toEqual({
        ok: false,
        code: 'invalid',
      });
    }
    expect(await t.call(LEADS, { requester: 'list', rowids: [5], generation: 0 })).toEqual({
      ok: false,
      code: 'stale_generation',
    });
    expect(t.queries).toEqual([]);
  });

  it("puts in the text of the window's search, and gives plain lines for an older or unknown one", async () => {
    const t = make();
    const first = await t.search('invoice');
    await t.call(LEADS, { requester: 'cards', rowids: [5], queryId: first, generation: 1 });
    await t.call(LEADS, { requester: 'cards', rowids: [5], queryId: first + 99, generation: 1 });
    const second = await t.search('lunch');
    await t.call(LEADS, { requester: 'cards', rowids: [5], queryId: first, generation: 1 });
    await t.call(LEADS, { requester: 'cards', rowids: [5], queryId: second, generation: 1 });
    expect(t.queries.filter((q) => q.op === 'leads')).toEqual([
      { op: 'leads', rowids: [5], text: 'invoice' },
      { op: 'leads', rowids: [5] },
      { op: 'leads', rowids: [5] },
      { op: 'leads', rowids: [5], text: 'lunch' },
    ]);
  });

  it('answers a list request and a cards request sent together while another runs', async () => {
    const t = make();
    t.hold();
    const running = t.call(LEADS, { requester: 'list', rowids: [1], generation: 1 });
    const list = t.call(LEADS, { requester: 'list', rowids: [2], generation: 1 });
    const cards = t.call(LEADS, { requester: 'cards', rowids: [3], generation: 1 });
    await new Promise((r) => setTimeout(r, 0));
    // Only one is in core at a time.
    expect(t.queries).toHaveLength(1);
    await t.release();
    for (const [result, rowid] of [
      [running, 1],
      [list, 2],
      [cards, 3],
    ] as const) {
      expect(await result).toMatchObject({ ok: true, leads: [{ rowid }] });
    }
  });

  it('lets a newer list request replace only the waiting list request', async () => {
    const t = make();
    t.hold();
    const running = t.call(LEADS, { requester: 'cards', rowids: [1], generation: 1 });
    const oldList = t.call(LEADS, { requester: 'list', rowids: [2], generation: 1 });
    const cards = t.call(LEADS, { requester: 'cards', rowids: [3], generation: 1 });
    const newList = t.call(LEADS, { requester: 'list', rowids: [4], generation: 1 });
    expect(await oldList).toEqual({ ok: false, code: 'superseded' });
    await t.release();
    expect(await running).toMatchObject({ ok: true });
    expect(await newList).toMatchObject({ ok: true, leads: [{ rowid: 4 }] });
    expect(await cards).toMatchObject({ ok: true, leads: [{ rowid: 3 }] });
    expect(t.queries.map((q) => (q.op === 'leads' ? q.rowids[0] : null))).toEqual([1, 4, 3]);
  });
});

describe('cards from a search in main', () => {
  it("puts in the text of the window's search, with the count's revision", async () => {
    const t = make();
    const queryId = await t.search('invoice');
    const result = await t.call(INDEX, {
      query: cardsQuery({ queryId, countRev: 4 }),
      generation: 1,
    });
    expect(result).toMatchObject({ ok: true });
    expect(t.queries.at(-1)).toEqual({
      ...cardsQuery(),
      search: { queryId, countRev: 4, text: 'invoice' },
    });
  });

  it('reads plain cards for an older or unknown search', async () => {
    const t = make();
    const first = await t.search('invoice');
    await t.search('lunch');
    for (const queryId of [first, first + 99]) {
      await t.call(INDEX, { query: cardsQuery({ queryId, countRev: null }), generation: 1 });
      expect(t.queries.at(-1)).toEqual(cardsQuery());
    }
  });

  it('refuses a search the shell gives text for, or a bad count revision', async () => {
    const t = make();
    const queryId = await t.search('invoice');
    for (const search of [
      { queryId, countRev: null, text: 'anything' },
      { queryId, countRev: -1 },
      { queryId, countRev: 1.5 },
      { queryId },
    ]) {
      expect(
        await t.call(INDEX, { query: cardsQuery(search), generation: 1 }),
        JSON.stringify(search),
      ).toEqual({ ok: false, code: 'invalid' });
    }
  });
});
