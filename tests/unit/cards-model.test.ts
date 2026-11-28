// SPDX-License-Identifier: AGPL-3.0-or-later
// The cards model: which conversation is shown, which card is expanded and
// opened, and what happens when the index moves on under it.

import { describe, expect, it } from 'vitest';
import { cardsWindow } from '../../src/core/index/queries';
import { asNumber, type Db } from '../../src/core/index/sql';
import type { CardsQuery, CardsWindow } from '../../src/shared/index-types';
import { CardsModel } from '../../src/renderer/cards';
import { fresh, ingest, message } from '../index-helpers';

const rowidOf = (db: Db, id: string) =>
  asNumber(db.stmt('SELECT rowid FROM messages WHERE proton_id = ?').get(id)?.rowid);

/** A conversation of `n` messages, t0 oldest, plus one other conversation. */
function setup(n = 6) {
  const { db, writer } = fresh();
  const rows = Array.from({ length: n }, (_, i) =>
    message(`t${i}`, i === 0 ? ['t0'] : [`t${i}`, 't0'], { time: 100 + i }),
  );
  rows.push(message('other', ['other'], { time: 10 }));
  ingest(writer, rows, 50);
  const ids = rows.slice(0, n).map((r) => rowidOf(db, r.protonId));
  const queries: CardsQuery[] = [];
  const actions: Array<['open', number] | ['close']> = [];
  let hold: Array<() => void> | null = null;
  const model = new CardsModel(
    (query) => {
      queries.push(query);
      const answer = (): CardsWindow => cardsWindow(db, query);
      if (!hold) return Promise.resolve(answer());
      // A read held until the test lets it go, answered from the index as it is then.
      return new Promise((resolve) => hold!.push(() => resolve(answer())));
    },
    () => undefined,
    {
      open: (rowid) => actions.push(['open', rowid]),
      close: () => actions.push(['close']),
    },
  );
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    db,
    writer,
    ids,
    model,
    queries,
    actions,
    settle,
    holdReads: () => {
      hold = [];
    },
    releaseReads: async () => {
      const waiting = hold ?? [];
      hold = null;
      for (const go of waiting) go();
      await settle();
      await settle();
    },
    /** Lets the reads waiting now go, and holds the ones that follow. */
    releaseHeld: async () => {
      const waiting = hold ?? [];
      hold = [];
      for (const go of waiting) go();
      await settle();
      await settle();
    },
  };
}

describe('the cards model', () => {
  it('shows the selected message expanded, opens it once, and lists the conversation', async () => {
    const { db, ids, model, actions, queries, settle } = setup();
    model.show(ids[3]!, null);
    expect(model.snapshot).toMatchObject({ shown: true, expanded: ids[3], ready: false });
    expect(actions).toEqual([['open', ids[3]]]);
    await settle();
    expect(queries[0]).toMatchObject({ op: 'cards', follow: [ids[3]], anchor: { rowid: ids[3] } });
    expect(model.snapshot).toMatchObject({ ready: true, total: 6, subject: 't0', gone: false });
    expect(model.snapshot.cards.map((c) => c.rowid)).toEqual(ids);
    expect(model.expandedIndex()).toBe(3);
    expect(actions).toEqual([['open', ids[3]]]);
    db.close();
  });

  it('expands another card: it opens, the scroll target moves, and the same card does nothing', async () => {
    const { db, ids, model, actions, settle } = setup();
    model.show(ids[5]!, null);
    await settle();
    const scroll = model.snapshot.scrollId;
    expect(model.expand(model.cardAt(1)!)).toBe(true);
    expect(model.snapshot.expanded).toBe(ids[1]);
    expect(model.snapshot.scrollId).toBe(scroll + 1);
    expect(model.expand(model.cardAt(1)!)).toBe(false);
    expect(actions).toEqual([
      ['open', ids[5]],
      ['open', ids[1]],
    ]);
    db.close();
  });

  it('keeps the expansion when the index moves on, and follows its message after a merge', async () => {
    const { db, writer, ids, model, actions, settle } = setup();
    model.show(ids[2]!, null);
    await settle();
    // The first read scrolls the expanded card's header to the top, with no shift on top of that.
    expect(model.snapshot).toMatchObject({ scrollId: 1, shiftId: 0 });
    // Another message joins the conversation: the expanded card stays as it is.
    ingest(writer, [message('late', ['late', 't0'], { time: 50 })], 1);
    model.refresh();
    await settle();
    expect(model.snapshot.total).toBe(7);
    expect(model.snapshot.expanded).toBe(ids[2]);
    // The new card arrived above the anchor: the cards scroll by one to keep it in place.
    expect(model.snapshot.shift).toBe(1);
    // A merge with the other conversation keeps it too.
    ingest(writer, [message('link', ['link', 't0', 'other'], { time: 300 })], 1);
    model.refresh();
    await settle();
    expect(model.snapshot.total).toBe(9);
    expect(model.snapshot.expanded).toBe(ids[2]);
    expect(actions).toEqual([['open', ids[2]]]);
    db.close();
  });

  it('opens the nearest card, newer first, when the expanded message is removed', async () => {
    const { db, ids, model, actions, settle } = setup();
    model.show(ids[2]!, null);
    await settle();
    db.exec(`DELETE FROM messages WHERE rowid = ${ids[2]!}`);
    model.refresh();
    await settle();
    expect(model.snapshot.expanded).toBe(ids[3]);
    expect(model.snapshot.total).toBe(5);
    // The newest removed, on screen: the one before it, one place up. Its
    // header scrolls to the top, with no shift on top of that.
    model.expand(model.cardAt(4)!);
    model.setViewport(0, 4);
    const { scrollId, shiftId } = model.snapshot;
    db.exec(`DELETE FROM messages WHERE rowid = ${ids[5]!}`);
    model.refresh();
    await settle();
    expect(model.snapshot.expanded).toBe(ids[4]);
    expect(model.snapshot).toMatchObject({ scrollId: scrollId + 1, shiftId });
    expect(actions).toEqual([
      ['open', ids[2]],
      ['open', ids[3]],
      ['open', ids[5]],
      ['open', ids[4]],
    ]);
    db.close();
  });

  it('opens the newest card left when the selected message goes before the first read', async () => {
    const { db, ids, model, actions, holdReads, releaseReads } = setup();
    const threadId = asNumber(
      db.stmt('SELECT thread_id FROM messages WHERE rowid = ?').get(ids[5]!)?.thread_id,
    );
    holdReads();
    model.show(ids[5]!, threadId);
    db.exec(`DELETE FROM messages WHERE rowid = ${ids[5]!}`);
    await releaseReads();
    expect(model.snapshot).toMatchObject({ expanded: ids[4], total: 5, gone: false });
    expect(model.expandedIndex()).toBe(4);
    expect(actions).toEqual([
      ['open', ids[5]],
      ['open', ids[4]],
    ]);
    db.close();
  });

  it('finds the removed card’s place even when the screen is elsewhere', async () => {
    const { db, ids, model, actions, queries, settle } = setup(40);
    model.show(ids[1]!, null);
    await settle();
    // The screen moves to the end; the expanded card is off screen.
    model.setViewport(30, 39);
    await settle();
    db.exec(`DELETE FROM messages WHERE rowid = ${ids[1]!}`);
    model.refresh();
    await settle();
    await settle();
    expect(model.snapshot.expanded).toBe(ids[2]);
    // The last read anchored at the removed card's place.
    expect(queries.at(-1)!.anchor).toMatchObject({
      rowid: ids[1],
      key: { time: 101, rowid: ids[1] },
    });
    expect(actions.at(-1)).toEqual(['open', ids[2]]);
    db.close();
  });

  it('revokes the removed card’s view at the first answer, while its place is still being read', async () => {
    const { db, ids, model, actions, queries, settle, holdReads, releaseReads } = setup(65);
    model.show(ids[1]!, null);
    await settle();
    model.setViewport(55, 64);
    await settle();
    await settle();
    const reads = queries.length;
    db.exec(`DELETE FROM messages WHERE rowid = ${ids[1]!}`);
    // The first read answers at once; the one for the removed card's place is held.
    model.refresh();
    holdReads();
    await settle();
    await settle();
    expect(queries.length).toBe(reads + 2);
    expect(queries.at(-1)!.anchor).toMatchObject({ rowid: ids[1] });
    expect(actions).toEqual([['open', ids[1]], ['close']]);
    await releaseReads();
    expect(model.snapshot.expanded).toBe(ids[2]);
    expect(actions).toEqual([['open', ids[1]], ['close'], ['open', ids[2]]]);
    db.close();
  });

  it('closes the reader and shows the conversation gone when no card is left', async () => {
    const { db, ids, model, actions, settle } = setup(2);
    model.show(ids[1]!, null);
    await settle();
    db.exec(`DELETE FROM messages WHERE rowid IN (${ids.join(',')})`);
    model.refresh();
    await settle();
    expect(model.snapshot).toMatchObject({ gone: true, expanded: null, total: 0, cards: [] });
    expect(actions).toEqual([['open', ids[1]], ['close']]);
    db.close();
  });

  it('a removed pending card whose answer comes late: no open for it, and a close with none left', async () => {
    const { db, ids, model, actions, settle, holdReads, releaseReads } = setup(3);
    model.show(ids[0]!, null);
    await settle();
    // The user expands the newest card; its read is under way when everything goes.
    holdReads();
    model.expand(model.cardAt(2)!);
    model.refresh();
    db.exec(`DELETE FROM messages WHERE rowid IN (${ids.join(',')})`);
    await releaseReads();
    expect(model.snapshot).toMatchObject({ gone: true, expanded: null });
    expect(actions).toEqual([['open', ids[0]], ['open', ids[2]], ['close']]);
    db.close();
  });

  it('drops a read for a conversation that was replaced while it was under way', async () => {
    const { db, ids, model, settle, holdReads, releaseReads } = setup();
    const other = rowidOf(db, 'other');
    holdReads();
    model.show(ids[0]!, null);
    model.show(other, null);
    await releaseReads();
    await settle();
    expect(model.snapshot.expanded).toBe(other);
    expect(model.snapshot.total).toBe(1);
    model.hide();
    expect(model.snapshot.shown).toBe(false);
    db.close();
  });

  it('drops a read that was under way when the conversation was hidden', async () => {
    const { db, ids, model, settle, holdReads, releaseReads } = setup(3);
    model.show(ids[0]!, null);
    await settle();
    db.exec(`DELETE FROM messages WHERE rowid IN (${ids.join(',')})`);
    model.refresh();
    await settle();
    expect(model.snapshot).toMatchObject({ gone: true, expanded: null });
    holdReads();
    model.refresh();
    model.hide();
    await releaseReads();
    expect(model.snapshot).toMatchObject({ shown: false, gone: false, ready: false, cards: [] });
    db.close();
  });

  it('a card expanded while a read is under way stays expanded, though the read finds the old one removed', async () => {
    const { db, ids, model, actions, settle, holdReads, releaseReads } = setup();
    model.show(ids[5]!, null);
    await settle();
    model.setViewport(0, 10);
    holdReads();
    model.refresh();
    expect(model.expand(model.cardAt(1)!)).toBe(true);
    db.exec(`DELETE FROM messages WHERE rowid = ${ids[5]}`);
    await releaseReads();
    await settle();
    expect(model.snapshot.expanded).toBe(ids[1]);
    expect(model.snapshot.total).toBe(5);
    expect(actions).toEqual([
      ['open', ids[5]],
      ['open', ids[1]],
    ]);
    db.close();
  });

  it('moves to the next newer and older card, stopping at either end', async () => {
    const { db, ids, model, actions, settle } = setup();
    model.show(ids[2]!, null);
    await settle();
    const scroll = model.snapshot.scrollId;
    expect(model.move(1)).toBe(true);
    expect(model.snapshot.expanded).toBe(ids[3]);
    expect(model.snapshot.scrollId).toBe(scroll + 1);
    expect(model.move(-1)).toBe(true);
    expect(model.move(-1)).toBe(true);
    expect(model.snapshot.expanded).toBe(ids[1]);
    expect(actions).toEqual([
      ['open', ids[2]],
      ['open', ids[3]],
      ['open', ids[2]],
      ['open', ids[1]],
    ]);
    // The oldest card: nothing older. The newest: nothing newer.
    model.show(ids[0]!, null);
    await settle();
    expect(model.move(-1)).toBe(false);
    model.show(ids[5]!, null);
    await settle();
    expect(model.move(1)).toBe(false);
    expect(model.snapshot.expanded).toBe(ids[5]);
    expect(actions.slice(4)).toEqual([
      ['open', ids[0]],
      ['open', ids[5]],
    ]);
    db.close();
  });

  it('does not move before the conversation is read, or with none shown', async () => {
    const { db, ids, model, actions, settle } = setup();
    expect(model.move(1)).toBe(false);
    model.show(ids[2]!, null);
    expect(model.move(1)).toBe(false);
    await settle();
    expect(model.snapshot.expanded).toBe(ids[2]);
    expect(actions).toEqual([['open', ids[2]]]);
    db.close();
  });

  it('reads at the expanded card first when the screen is elsewhere, then moves', async () => {
    const { db, ids, model, actions, queries, settle } = setup(400);
    model.show(ids[0]!, null);
    await settle();
    model.setViewport(300, 310);
    await settle();
    expect(model.expandedIndex()).toBeNull();
    const reads = queries.length;
    expect(model.move(1)).toBe(true);
    await settle();
    await settle();
    expect(queries.length).toBe(reads + 1);
    expect(queries.at(-1)!.anchor).toMatchObject({ rowid: ids[0] });
    expect(model.snapshot.expanded).toBe(ids[1]);
    expect(actions).toEqual([
      ['open', ids[0]],
      ['open', ids[1]],
    ]);
    db.close();
  });

  it('adds up the moves made while that read is under way, and opens only where they end', async () => {
    const { db, ids, model, actions, settle, holdReads, releaseReads } = setup(400);
    model.show(ids[10]!, null);
    await settle();
    model.setViewport(300, 310);
    await settle();
    holdReads();
    model.move(1);
    model.move(1);
    model.move(1);
    model.move(-1);
    await releaseReads();
    expect(model.snapshot.expanded).toBe(ids[12]);
    expect(actions).toEqual([
      ['open', ids[10]],
      ['open', ids[12]],
    ]);
    db.close();
  });

  it('moves that add up past either end during that read stop at the end card', async () => {
    for (const [start, step, end] of [
      [398, 1, 399],
      [1, -1, 0],
    ] as const) {
      const { db, ids, model, actions, settle, holdReads, releaseHeld, releaseReads } = setup(400);
      model.show(ids[start]!, null);
      await settle();
      model.setViewport(200, 210);
      await settle();
      holdReads();
      model.move(step);
      model.move(step);
      model.move(step);
      // The end card is among those read at the expanded one: it opens with no other read.
      await releaseHeld();
      expect(model.snapshot.expanded).toBe(ids[end]);
      await releaseReads();
      expect(model.snapshot.expanded).toBe(ids[end]);
      expect(actions).toEqual([
        ['open', ids[start]],
        ['open', ids[end]],
      ]);
      db.close();
    }
  });

  it('keeps a move made while a read for the screen is under way, and opens only where it ends', async () => {
    const { db, ids, model, actions, queries, settle, holdReads, releaseReads } = setup(400);
    model.show(ids[10]!, null);
    await settle();
    model.setViewport(300, 310);
    await settle();
    expect(model.expandedIndex()).toBeNull();
    // The screen moves again: its read is under way when the key comes.
    holdReads();
    model.setViewport(200, 210);
    const reads = queries.length;
    expect(queries.at(-1)!.anchor).not.toHaveProperty('rowid', ids[10]);
    expect(model.move(1)).toBe(true);
    await releaseReads();
    await settle();
    // The screen's read came back without the expanded card; the next read is at its place.
    expect(queries.length).toBe(reads + 1);
    expect(queries.at(-1)!.anchor).toMatchObject({ rowid: ids[10] });
    expect(model.snapshot.expanded).toBe(ids[11]);
    expect(actions).toEqual([
      ['open', ids[10]],
      ['open', ids[11]],
    ]);
    db.close();
  });

  it('moves that end past the cards read at the expanded one read there, then open only that card', async () => {
    for (const [start, step, presses, end] of [
      [100, -1, 60, 40],
      [100, 1, 120, 220],
    ] as const) {
      const { db, ids, model, actions, queries, settle, holdReads, releaseReads } = setup(400);
      model.show(ids[start]!, null);
      await settle();
      model.setViewport(300, 310);
      await settle();
      holdReads();
      const reads = queries.length;
      for (let i = 0; i < presses; i += 1) model.move(step);
      await releaseReads();
      await settle();
      await settle();
      // Read at the expanded card first, then where the moves end.
      expect(queries[reads]!.anchor).toMatchObject({ rowid: ids[start] });
      expect(queries[reads + 1]!.anchor).toEqual({ index: end });
      expect(model.snapshot.expanded).toBe(ids[end]);
      expect(actions).toEqual([
        ['open', ids[start]],
        ['open', ids[end]],
      ]);
      db.close();
    }
  });

  it('adds moves made while the cards where moves end are read, stopping at either end', async () => {
    for (const [start, view, step, first, more, end] of [
      [100, 300, -1, 60, 5, 35],
      [100, 300, -1, 60, 50, 0],
      [300, 100, 1, 90, 20, 399],
    ] as const) {
      const { db, ids, model, actions, settle, holdReads, releaseHeld, releaseReads } = setup(400);
      model.show(ids[start]!, null);
      await settle();
      model.setViewport(view, view + 10);
      await settle();
      holdReads();
      for (let i = 0; i < first; i += 1) model.move(step);
      // The read at the expanded card answers; the read where the moves end is held.
      await releaseHeld();
      expect(model.snapshot.expanded).toBe(ids[start]);
      for (let i = 0; i < more; i += 1) model.move(step);
      await releaseReads();
      await settle();
      expect(model.snapshot.expanded).toBe(ids[end]);
      expect(actions).toEqual([
        ['open', ids[start]],
        ['open', ids[end]],
      ]);
      db.close();
    }
  });

  it('a card expanded by hand while the cards where moves end are read replaces the move', async () => {
    const { db, ids, model, actions, settle, holdReads, releaseHeld, releaseReads } = setup(400);
    model.show(ids[100]!, null);
    await settle();
    model.setViewport(300, 310);
    await settle();
    holdReads();
    for (let i = 0; i < 60; i += 1) model.move(-1);
    await releaseHeld();
    // The read at card 40 is held; card 150 is held from the read at the expanded card.
    expect(model.expand(model.cardAt(150)!)).toBe(true);
    await releaseReads();
    await settle();
    await settle();
    expect(model.snapshot.expanded).toBe(ids[150]);
    expect(actions).toEqual([
      ['open', ids[100]],
      ['open', ids[150]],
    ]);
    db.close();
  });

  it('a card expanded by hand while that read is under way replaces the move', async () => {
    const { db, ids, model, actions, settle, holdReads, releaseReads } = setup(400);
    model.show(ids[0]!, null);
    await settle();
    model.setViewport(300, 310);
    await settle();
    holdReads();
    model.move(1);
    expect(model.expand(model.cardAt(305)!)).toBe(true);
    await releaseReads();
    await settle();
    expect(model.snapshot.expanded).toBe(ids[305]);
    expect(actions).toEqual([
      ['open', ids[0]],
      ['open', ids[305]],
    ]);
    db.close();
  });

  it('reads more cards when the screen leaves the ones held, and only then', async () => {
    const { db, ids, model, queries, settle } = setup(400);
    model.show(ids[0]!, null);
    await settle();
    const held = model.snapshot.cards.length;
    expect(held).toBeLessThan(400);
    const reads = queries.length;
    model.setViewport(0, 5);
    expect(queries.length).toBe(reads);
    model.setViewport(300, 310);
    await settle();
    expect(queries.length).toBe(reads + 1);
    expect(model.cardAt(305)?.rowid).toBe(ids[305]);
    expect(model.snapshot.expanded).toBe(ids[0]);
    db.close();
  });
});
