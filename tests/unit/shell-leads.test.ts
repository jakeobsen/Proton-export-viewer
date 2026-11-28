// SPDX-License-Identifier: AGPL-3.0-or-later
// The lead lines model: only messages on screen are asked for, a request at a
// time; lines are kept until a newer answer replaces them; the messages on
// screen are asked again when the index moves on; and answers for a search
// or a generation left behind are dropped.

import { describe, expect, it } from 'vitest';
import type { LeadsRequest } from '../../src/shared/api';
import type { Lead } from '../../src/shared/index-types';
import { LeadsModel, MAX_LINES } from '../../src/renderer/leads';

function setup() {
  const requests: LeadsRequest[] = [];
  const waiting: Array<(leads: Lead[] | null) => void> = [];
  /** What each message's line says now; a missing one has no line yet. */
  const text = new Map<number, string>();
  let changes = 0;
  const model = new LeadsModel(
    'cards',
    (request) => {
      requests.push(request);
      return new Promise((resolve) => waiting.push(resolve));
    },
    () => (changes += 1),
  );
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  /** Answers the oldest waiting request from `text`, or with no answer. */
  const answer = async (fail = false) => {
    const request = requests[requests.length - waiting.length]!;
    const resolve = waiting.shift()!;
    resolve(
      fail
        ? null
        : request.rowids.map((rowid) => ({
            rowid,
            text: text.get(rowid) ?? null,
            snippet: null,
          })),
    );
    await settle();
  };
  return { model, requests, waiting, text, answer, changes: () => changes };
}

const lines = (model: LeadsModel) =>
  Object.fromEntries([...model.snapshot].map(([rowid, line]) => [rowid, line.text]));

describe('lead lines in the shell', () => {
  it('asks only for the messages on screen, at most 50, one request at a time', async () => {
    const t = setup();
    const onScreen = Array.from({ length: 60 }, (_, i) => i + 1);
    t.model.show(onScreen);
    t.model.show(onScreen);
    expect(t.requests).toEqual([{ requester: 'cards', rowids: onScreen.slice(0, 50) }]);
    await t.answer();
    // Then the rest; nothing answered is asked for again.
    expect(t.requests[1]).toEqual({ requester: 'cards', rowids: onScreen.slice(50) });
    await t.answer();
    t.model.show(onScreen.slice(0, 5));
    expect(t.requests).toHaveLength(2);
  });

  it('keeps the lines held until a newer answer replaces them, and asks again when the index moves on', async () => {
    const t = setup();
    t.text.set(1, 'first');
    t.model.show([1, 2]);
    await t.answer();
    expect(lines(t.model)).toEqual({ 1: 'first', 2: null });
    // The body of 2 is indexed, and 1's line changed.
    t.text.set(1, 'second');
    t.text.set(2, 'now indexed');
    t.model.changed();
    expect(t.requests[1]!.rowids).toEqual([1, 2]);
    // While asked again, the old lines stay.
    expect(lines(t.model)).toEqual({ 1: 'first', 2: null });
    await t.answer();
    expect(lines(t.model)).toEqual({ 1: 'second', 2: 'now indexed' });
  });

  it('asks again for an answer read before the index moved on', async () => {
    const t = setup();
    t.model.show([1]);
    t.model.changed();
    // One request at a time: the move waits for the answer, which is shown and asked again.
    expect(t.requests).toHaveLength(1);
    await t.answer();
    expect(t.requests).toHaveLength(2);
    t.text.set(1, 'indexed');
    await t.answer();
    expect(lines(t.model)).toEqual({ 1: 'indexed' });
    expect(t.requests).toHaveLength(2);
  });

  it('asks again on the next change of screen when no answer came', async () => {
    const t = setup();
    t.model.show([1]);
    await t.answer(true);
    expect(lines(t.model)).toEqual({});
    t.model.show([1]);
    expect(t.requests).toHaveLength(2);
  });

  it('names the search, starts afresh for a new one, and drops answers for one left behind', async () => {
    const t = setup();
    t.text.set(1, 'plain');
    t.model.show([1]);
    await t.answer();
    expect(lines(t.model)).toEqual({ 1: 'plain' });
    t.model.show([1], 7);
    // The lines of another search are dropped at once.
    expect(lines(t.model)).toEqual({});
    expect(t.requests.at(-1)).toEqual({ requester: 'cards', rowids: [1], queryId: 7 });
    t.model.show([1], null);
    // The answer for search 7 comes late: it is dropped.
    t.text.set(1, 'for search 7');
    await t.answer();
    expect(lines(t.model)).toEqual({});
    t.text.set(1, 'plain again');
    await t.answer();
    expect(lines(t.model)).toEqual({ 1: 'plain again' });
  });

  it(`asks again for a message whose line was let go past ${MAX_LINES} lines, once it is back on screen`, async () => {
    const t = setup();
    const rows = Array.from({ length: MAX_LINES + 50 }, (_, i) => i + 1);
    for (const r of rows) t.text.set(r, `line ${r}`);
    // The first 50 messages are answered, then the screen moves on, 50 at a time.
    for (let first = 0; first < rows.length; first += 50) {
      t.model.show(rows.slice(first, first + 50));
      await t.answer();
    }
    // Past the limit, only the lines on screen were kept.
    expect(t.model.snapshot.has(1)).toBe(false);
    expect(t.model.snapshot.has(MAX_LINES + 1)).toBe(true);
    const asked = t.requests.length;
    // Back at the top, with no index change: the messages are asked for again and shown.
    t.model.show(rows.slice(0, 50));
    expect(t.requests).toHaveLength(asked + 1);
    expect(t.requests[asked]!.rowids).toEqual(rows.slice(0, 50));
    await t.answer();
    expect(lines(t.model)[1]).toBe('line 1');
  });

  it('drops an answer for a generation left behind', async () => {
    const t = setup();
    t.text.set(1, 'old');
    t.model.show([1]);
    t.model.reset();
    await t.answer();
    expect(lines(t.model)).toEqual({});
    t.model.show([1]);
    t.text.set(1, 'new');
    await t.answer();
    expect(lines(t.model)).toEqual({ 1: 'new' });
  });
});
