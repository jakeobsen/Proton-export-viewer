// SPDX-License-Identifier: AGPL-3.0-or-later
// When the shell reads the index report: on every index update while it is on
// screen, and with it closed once phase 1 is done only when an update moved
// a count the list header's number can change with; never more than once a
// second.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndexProgress, IndexReport } from '../../src/shared/index-types';

const GENERATION = 1;
const START: IndexProgress = {
  phase: 'loading',
  loaded: 2,
  total: 5,
  failed: 0,
  timeouts: 0,
  capped: 0,
  condition: 'ok',
  bodyPhase: 'waiting',
  bodiesDone: 0,
  bodiesTotal: 0,
  bodiesFailed: 0,
};
const REPORT: IndexReport = {
  messages: 5,
  folders: 0,
  took: 10,
  rejected: {},
  metaMissing: 0,
  emlMissing: 0,
  failed: {},
  timeouts: 0,
  capped: {},
  cappedMessages: 0,
  hiddenLabelIds: 0,
  attention: 0,
  rows: [],
  more: 0,
};

/** The progress core last reported; answers carry it too. */
let progress = START;

const pev = {
  state: vi.fn(async () => ({ ok: true, generation: GENERATION })),
  sources: vi.fn(async () => ({
    ok: true,
    generation: GENERATION,
    sources: { restoring: false, active: { sourceKey: 'export-1' }, recent: [] },
  })),
  sidebar: vi.fn(async () => ({ ok: false, code: 'core_unavailable' })),
  listWindow: vi.fn(async () => ({ ok: false, code: 'core_unavailable' })),
  cards: vi.fn(async () => ({ ok: false, code: 'core_unavailable' })),
  indexReport: vi.fn(async () => ({ ok: true, generation: GENERATION, answer: REPORT, progress })),
};
(globalThis as unknown as { window: { pev: typeof pev } }).window = { pev };

const shell = await import('../../src/renderer/shell');
const mailbox = await import('../../src/renderer/mailbox-state');

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

/** Core reports `change` on top of the last progress. */
async function report(change: Partial<IndexProgress>): Promise<void> {
  progress = { ...progress, ...change };
  mailbox.indexChanged({ generation: GENERATION, progress });
  await flush();
}

const reads = () => pev.indexReport.mock.calls.length;

/** Lets the once-a-second limit pass. */
async function later(): Promise<void> {
  vi.advanceTimersByTime(mailbox.REPORT_MS);
  await flush();
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  await shell.refreshSources();
  mailbox.syncMailbox();
  expect(mailbox.getMailboxState().key).toBe(`export-1:${GENERATION}`);
});

afterAll(() => {
  vi.useRealTimers();
});

// Each test starts closed, in phase 1, with nothing read for a second.
beforeEach(async () => {
  mailbox.closeReport();
  progress = START;
  await report({});
  await later();
  pev.indexReport.mockClear();
});

describe('the index report, closed', () => {
  it('is read once phase 1 is done, then only when a count it shows can move', async () => {
    await report({ loaded: 3 });
    await later();
    expect(reads()).toBe(0);

    await report({ phase: 'done', loaded: 5, bodyPhase: 'indexing', bodiesTotal: 5 });
    expect(reads()).toBe(1);
    expect(mailbox.getMailboxState().report).toEqual(REPORT);

    // Phase 2 moving on, with nothing the header counts changed: not read.
    for (let done = 1; done <= 3; done += 1) {
      await later();
      await report({ bodiesDone: done });
    }
    expect(reads()).toBe(1);

    for (const [change, n] of [
      [{ capped: 1 }, 2],
      [{ bodiesFailed: 1 }, 3],
      [{ failed: 1 }, 4],
      [{ timeouts: 1 }, 5],
      [{ phase: 'loading' }, 5],
      [{ phase: 'done' }, 6],
    ] as Array<[Partial<IndexProgress>, number]>) {
      await later();
      await report(change);
      expect(reads(), JSON.stringify(change)).toBe(n);
    }
  });

  it('is read at most once a second, and the last move is not lost', async () => {
    await report({ phase: 'done' });
    expect(reads()).toBe(1);
    await report({ capped: 1 });
    await report({ capped: 2 });
    expect(reads()).toBe(1);
    vi.advanceTimersByTime(mailbox.REPORT_MS - 1);
    await flush();
    expect(reads()).toBe(1);
    vi.advanceTimersByTime(1);
    await flush();
    expect(reads()).toBe(2);
    await later();
    expect(reads()).toBe(2);
  });
});

describe('the index report, on screen', () => {
  it('is read when it opens and on every update, at most once a second', async () => {
    await report({ phase: 'done' });
    expect(reads()).toBe(1);
    mailbox.openReport();
    await flush();
    expect(reads()).toBe(2);
    await later();
    await report({ bodiesDone: 1 });
    expect(reads()).toBe(3);
    await report({ bodiesDone: 2 });
    expect(reads()).toBe(3);
    await later();
    expect(reads()).toBe(4);

    // Closed again: the same counts aren't read again.
    mailbox.closeReport();
    await later();
    await report({ bodiesDone: 3 });
    await later();
    expect(reads()).toBe(4);
  });

  it('keeps card keys from moving the cards until it closes', () => {
    const move = vi.spyOn(mailbox.cards, 'move').mockReturnValue(true);
    try {
      mailbox.openReport();
      mailbox.moveCard('n');
      mailbox.moveCard('p');
      expect(move).not.toHaveBeenCalled();
      mailbox.closeReport();
      mailbox.moveCard('p');
      expect(move.mock.calls).toEqual([[-1]]);
    } finally {
      move.mockRestore();
    }
  });

  it('closed while phase 1 runs, the end of phase 1 is still read', async () => {
    mailbox.openReport();
    await flush();
    expect(reads()).toBe(1);
    mailbox.closeReport();
    await later();
    // The next update is the end of phase 1, with the same counts.
    await report({ phase: 'done' });
    expect(reads()).toBe(2);
  });
});
