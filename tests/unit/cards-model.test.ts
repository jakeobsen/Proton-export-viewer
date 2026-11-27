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
    // The newest removed: the one before it, one place up. Its header
    // scrolls to the top, with no shift on top of that.
    model.expand(model.cardAt(4)!);
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
