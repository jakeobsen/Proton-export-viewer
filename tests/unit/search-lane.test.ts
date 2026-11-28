// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { SUPERSEDED, SearchLanes } from '../../src/main/search-lane';

/** A task that ends when the test says so. */
function gate<T>(value: T) {
  let open!: () => void;
  let fail!: (err: Error) => void;
  let started = false;
  const done = new Promise<T>((resolve, reject) => {
    open = () => resolve(value);
    fail = reject;
  });
  return {
    task: () => {
      started = true;
      return done;
    },
    open,
    fail,
    started: () => started,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('search lanes', () => {
  it('runs one search per window, keeps one waiting, and a newer one replaces it', async () => {
    const lanes = new SearchLanes<object>();
    const win = {};
    const a = gate('a');
    const b = gate('b');
    const c = gate('c');
    const ra = lanes.run(win, a.task);
    const rb = lanes.run(win, b.task);
    const rc = lanes.run(win, c.task);
    expect(a.started()).toBe(true);
    expect(lanes.busy(win)).toBe(true);
    // b never runs: c took its place while a was running.
    expect(await rb).toBe(SUPERSEDED);
    expect(b.started()).toBe(false);
    expect(c.started()).toBe(false);
    a.open();
    expect(await ra).toBe('a');
    await tick();
    expect(c.started()).toBe(true);
    c.open();
    expect(await rc).toBe('c');
    expect(lanes.busy(win)).toBe(false);
  });

  it('keeps windows apart', async () => {
    const lanes = new SearchLanes<object>();
    const one = gate(1);
    const two = gate(2);
    const r1 = lanes.run({}, one.task);
    const r2 = lanes.run({}, two.task);
    expect(one.started() && two.started()).toBe(true);
    one.open();
    two.open();
    expect([await r1, await r2]).toEqual([1, 2]);
  });

  it('passes a failure on and goes on with the waiting search', async () => {
    const lanes = new SearchLanes<object>();
    const win = {};
    const a = gate('a');
    const b = gate('b');
    const ra = lanes.run(win, a.task);
    const rb = lanes.run(win, b.task);
    a.fail(new Error('boom'));
    await expect(ra).rejects.toThrow('boom');
    await tick();
    expect(b.started()).toBe(true);
    b.open();
    expect(await rb).toBe('b');
  });

  it('keeps one waiting request per requester: neither pushes the other out', async () => {
    const lanes = new SearchLanes<object>();
    const win = {};
    const running = gate('running');
    const list = gate('list');
    const cards = gate('cards');
    const rRunning = lanes.run(win, running.task, 'list');
    // The list and the cards ask at the same moment, while another request runs.
    const rList = lanes.run(win, list.task, 'list');
    const rCards = lanes.run(win, cards.task, 'cards');
    running.open();
    expect(await rRunning).toBe('running');
    await tick();
    expect(list.started()).toBe(true);
    expect(cards.started()).toBe(false);
    list.open();
    expect(await rList).toBe('list');
    await tick();
    expect(cards.started()).toBe(true);
    cards.open();
    expect(await rCards).toBe('cards');
  });

  it("lets a newer request replace only its own requester's waiting one, which keeps its place", async () => {
    const lanes = new SearchLanes<object>();
    const win = {};
    const running = gate('running');
    const oldList = gate('old list');
    const cards = gate('cards');
    const newList = gate('new list');
    const rRunning = lanes.run(win, running.task, 'cards');
    const rOld = lanes.run(win, oldList.task, 'list');
    const rCards = lanes.run(win, cards.task, 'cards');
    const rNew = lanes.run(win, newList.task, 'list');
    expect(await rOld).toBe(SUPERSEDED);
    running.open();
    await rRunning;
    await tick();
    // The list's place came first, so its newer request runs first.
    expect(newList.started()).toBe(true);
    expect(cards.started()).toBe(false);
    newList.open();
    expect(await rNew).toBe('new list');
    await tick();
    cards.open();
    expect(await rCards).toBe('cards');
    expect(oldList.started()).toBe(false);
  });
});
