// SPDX-License-Identifier: AGPL-3.0-or-later
// The list rows' lead lines in the shell are asked for only while the list is
// on screen: with a search's results in its place, an index change reads the
// list again but asks for no row's line, and the rows on screen are asked for
// once the list is back.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { listWindow } from '../../src/core/index/queries';
import type { LeadsRequest } from '../../src/shared/api';
import type { IndexProgress, WindowQuery } from '../../src/shared/index-types';
import { fresh, ingest, message } from '../index-helpers';

const GENERATION = 1;
const PROGRESS = {
  phase: 'done',
  loaded: 3,
  total: 3,
  failed: 0,
  timeouts: 0,
} as IndexProgress;

const { db, writer } = fresh();
ingest(
  writer,
  ['a', 'b', 'c'].map((id, i) => message(id, [id], { time: 100 + i, labelIds: ['0', '5'] })),
  50,
);

const unavailable = vi.fn(async () => ({ ok: false, code: 'core_unavailable' }));
const pev = {
  state: vi.fn(async () => ({ ok: true, generation: GENERATION })),
  sources: vi.fn(async () => ({
    ok: true,
    generation: GENERATION,
    sources: { restoring: false, active: { sourceKey: 'export-1' }, recent: [] },
  })),
  sidebar: unavailable,
  listWindow: vi.fn(async (query: WindowQuery) => ({
    ok: true,
    generation: GENERATION,
    answer: listWindow(db, query),
    progress: PROGRESS,
  })),
  cards: unavailable,
  indexReport: unavailable,
  leads: vi.fn(async (request: LeadsRequest) => ({
    ok: true,
    generation: GENERATION,
    leads: request.rowids.map((rowid) => ({ rowid, text: `lead ${rowid}`, snippet: null })),
  })),
};
(globalThis as unknown as { window: { pev: typeof pev } }).window = { pev };

const shell = await import('../../src/renderer/shell');
const mailbox = await import('../../src/renderer/mailbox-state');

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

/** The rowids of each list request for lead lines since the last call. */
function listRequests(): number[][] {
  const asked = pev.leads.mock.calls
    .map(([request]) => request)
    .filter((request) => request.requester === 'list')
    .map((request) => [...request.rowids].sort((x, y) => x - y));
  pev.leads.mockClear();
  return asked;
}

const rowids = () =>
  db
    .stmt('SELECT rowid FROM messages ORDER BY rowid')
    .all()
    .map((r) => Number(r.rowid));

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await shell.refreshSources();
  mailbox.syncMailbox();
  await flush();
  expect(mailbox.list.snapshot.total).toBe(3);
});

afterAll(() => {
  vi.useRealTimers();
  db.close();
});

describe("the list rows' lead lines", () => {
  it('are asked for only while the list is on screen', async () => {
    // The rows on screen are known before the list shows: nothing is asked yet.
    mailbox.setListViewport(0, 2);
    await flush();
    expect(listRequests()).toEqual([]);
    mailbox.setListShown(true);
    await flush();
    expect(listRequests()).toEqual([rowids()]);
    expect(mailbox.listLeads.snapshot.size).toBe(3);

    // Results show in its place: the index moves on, and the list is read
    // again, but no row's line is asked for.
    mailbox.setListShown(false);
    const reads = pev.listWindow.mock.calls.length;
    mailbox.indexChanged({ generation: GENERATION, progress: PROGRESS });
    await flush();
    expect(pev.listWindow.mock.calls.length).toBeGreaterThan(reads);
    expect(listRequests()).toEqual([]);

    // Back on screen, its rows are asked for again.
    mailbox.setListShown(true);
    await flush();
    expect(listRequests()).toEqual([rowids()]);
  });
});
