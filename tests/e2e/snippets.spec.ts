// SPDX-License-Identifier: AGPL-3.0-or-later
// Lead lines and snippets in the shell: list rows and cards get each
// message's first words once phase 2 indexes its body, as text, cleaned and
// isolated; a conversation opened from a result says how many of its
// messages match, shows the search's snippet on those cards and expands its
// newest matching message; and the header's two counts always come from one
// snapshot, also when a read waited in core while a write landed.

import { realpathSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import type { IndexProgress, IndexTotals, SearchPage } from '../../src/shared/index-types';
import { writeExport } from '../exports';
import { testDir } from '../paths';
import { writeMessage } from '../thread-export';
import { expect, test, type PevApp } from './app';
import { mailboxFollows } from './search-ui';

type Answer<T> = { answer: T; progress: IndexProgress } | null;
const ask = <T>(pev: PevApp, query: unknown) => pev.main<Answer<T>>('indexQuery', query);

const T0 = 1_780_000_000;
const LEE = { name: 'Lee', address: 'lee@example.com' };
const KIM = { name: 'Kim', address: 'kim@example.com' };

interface Msg {
  id: string;
  time: number;
  subject: string;
  body: string;
  from?: { name: string; address: string };
  /** The message this one replies to: same conversation. */
  replyTo?: string;
}

/** An export of exactly these messages, in Inbox and All Mail. */
function exportOf(name: string, messages: Msg[]): { root: string; pairs: number } {
  const root = realpathSync(testDir(name));
  const base = writeExport(root, { seed: 75, messages: 0 });
  for (const m of messages) {
    writeMessage(base.run, m.id, {
      time: m.time,
      subject: m.subject,
      from: m.from ?? LEE,
      labels: ['0', '5'],
      messageId: `${m.id}@example.com`,
      references: m.replyTo ? [`${m.replyTo}@example.com`] : [],
      body: m.body,
    });
  }
  return { root, pairs: messages.length };
}

const progress = async (pev: PevApp) => (await ask<IndexTotals>(pev, { op: 'totals' }))?.progress;

/**
 * Opens `root` with no body indexed: writes are held, phase 1's go through
 * one at a time until it is done, and phase 2's stay held. With `txnBytes`,
 * a phase 2 write holds at most that much text.
 */
async function openBodiesHeld(
  pev: PevApp,
  root: string,
  pairs: number,
  txnBytes?: number,
): Promise<void> {
  await pev.main('indexTestSettings', { holdWrites: true, ...(txnBytes ? { txnBytes } : {}) });
  await pev.main('queuePick', root, 'bm1');
  await pev.shell('chooseFolder', []);
  await expect
    .poll(
      async () => {
        const p = await progress(pev);
        if (p?.phase === 'done' && p.loaded === pairs) return true;
        if ((await pev.main<number>('heldWrites')) > 0) await pev.main('releaseWrites', 1);
        return false;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  await pev.main('indexTestSettings', null);
  await mailboxFollows(pev);
}

/** Lets the held bodies be written, and waits until all are, as text. */
async function releaseBodies(pev: PevApp, pairs: number): Promise<void> {
  await pev.main('releaseWrites', null);
  await expect
    .poll(() => progress(pev), { timeout: 20_000 })
    .toMatchObject({ bodyPhase: 'done', bodiesDone: pairs, bodiesTotal: pairs, bodiesFailed: 0 });
}

/**
 * Each body of these messages is about 320 bytes of text, and its subject and
 * names under 100 more: one fits in a write of this much text, two don't.
 */
const ONE_BODY = 500;
const FILLER = 'notes '.repeat(50);

/** Lets one more held write through, one body, and waits until it is written as text. */
async function releaseBody(pev: PevApp, done: number): Promise<void> {
  await expect.poll(() => pev.main<number>('heldWrites'), { timeout: 20_000 }).toBeGreaterThan(0);
  await pev.main('releaseWrites', 1);
  await expect.poll(() => progress(pev)).toMatchObject({ bodiesDone: done, bodiesFailed: 0 });
}

const press = (page: Page, selector: string) => page.locator(selector).dispatchEvent('click');

/**
 * Scrolls the cards to the top or the end, as the user does. Only the cards
 * on screen get their lines, and a conversation opens scrolled to its
 * expanded card, which fills the pane.
 */
function scrollCards(page: Page, to: 'top' | 'end'): Promise<void> {
  return page.locator('.cv-scroll').evaluate((el, where) => {
    el.scrollTop = where === 'top' ? 0 : el.scrollHeight;
    el.dispatchEvent(new Event('scroll'));
  }, to);
}

function typeText(page: Page, text: string): Promise<void> {
  return page.evaluate((t) => {
    const box = document.querySelector<HTMLInputElement>('.search-box');
    if (!box) throw new Error('no search box');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(box, t);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
}

interface CardsState {
  shown: boolean;
  threadId: number | null;
  expanded: number | null;
  count: { total: number; matching: number | null; rev: number } | null;
  cards: Array<{ rowid: number; time: number; matched?: boolean }>;
}
const cardsState = (pev: PevApp) => pev.shell<CardsState>('cards');

/** The left and right edges of each part of `scope`, and whether it is isolated. */
function boxes(scope: Locator, selectors: string[]) {
  return scope.evaluate((el, all) => {
    return all.map((s) => {
      const part = el.querySelector<HTMLElement>(s);
      if (!part) throw new Error(`no ${s}`);
      const box = part.getBoundingClientRect();
      const style = getComputedStyle(part);
      return { left: box.left, right: box.right, isolated: style.unicodeBidi === 'isolate' };
    });
  }, selectors);
}

async function inOrder(scope: Locator, selectors: string[]): Promise<void> {
  const found = await boxes(scope, selectors);
  for (let i = 1; i < found.length; i += 1) {
    expect(found[i]!.left).toBeGreaterThanOrEqual(found[i - 1]!.right);
  }
}

test('list rows and cards get their lead lines once phase 2 indexes the bodies, as text', async ({
  pev,
}) => {
  const { root, pairs } = exportOf('snip-leads', [
    { id: 'S1', time: T0, subject: 'Hike', body: 'Shall we go up the ridge on Saturday?' },
    {
      id: 'S2',
      time: T0 + 60,
      subject: 'Re: Hike',
      body: 'Yes!\r\n\r\n  The loop is   11 km.',
      replyTo: 'S1',
      from: KIM,
    },
    { id: 'S3', time: T0 + 120, subject: 'Re: Hike', body: 'See you at 8.', replyTo: 'S1' },
    { id: 'L1', time: T0 - 600, subject: 'Prices', body: 'Price <b>bold</b> list for May' },
  ]);
  await openBodiesHeld(pev, root, pairs);
  const rows = pev.page.locator('.conv:not(.result)');
  await expect(rows).toHaveCount(2);
  const hike = rows.filter({ hasText: 'Hike' });
  const prices = rows.filter({ hasText: 'Prices' });
  // No body is indexed yet: no line.
  await expect(hike.locator('.snip')).toHaveText('');
  await expect(prices.locator('.snip')).toHaveText('');
  // The conversation is open, with its two older cards collapsed, on screen.
  await press(pev.page, `.conv[data-thread="${await hike.getAttribute('data-thread')}"]`);
  const cards = pev.page.locator('.card');
  await expect(cards).toHaveCount(3);
  await scrollCards(pev.page, 'top');
  await expect(cards.nth(0).locator('.ch-snip')).toHaveText('');
  await expect(cards.nth(1).locator('.ch-snip')).toHaveText('');

  // The indexed bodies bring their lines, row and card, with no other step.
  await releaseBodies(pev, pairs);
  await expect(hike.locator('.snip')).toHaveText('See you at 8.');
  await expect(prices.locator('.snip')).toHaveText('Price <b>bold</b> list for May');
  await expect(prices.locator('.snip b')).toHaveCount(0);
  await expect(cards.nth(0).locator('.ch-snip')).toHaveText(
    'Shall we go up the ridge on Saturday?',
  );
  // White space as one line shows it.
  await expect(cards.nth(1).locator('.ch-snip')).toHaveText('Yes! The loop is 11 km.');
  // The expanded card shows its body instead.
  await expect(cards.nth(2).locator('.ch-snip')).toHaveCount(0);
  // Both lines sit below the name and subject lines, as isolated runs of text.
  expect((await boxes(hike, ['.snip']))[0]!.isolated).toBe(true);
  expect((await boxes(cards.nth(0), ['.ch-snip']))[0]!.isolated).toBe(true);
});

test("a body that starts with an override shows cleaned and leaves its row's name and date in order", async ({
  pev,
}) => {
  const { root, pairs } = exportOf('snip-bidi', [
    {
      id: 'B1',
      time: T0,
      subject: 'Notice',
      body: '\u202e\u200bPay\u0007 now, or else',
      from: { name: 'Eve Mallory', address: 'eve@example.com' },
    },
    { id: 'B2', time: T0 + 60, subject: 'Re: Notice', body: 'No.', replyTo: 'B1', from: KIM },
  ]);
  await openBodiesHeld(pev, root, pairs);
  await releaseBodies(pev, pairs);
  const row = pev.page.locator('.conv:not(.result)').first();
  await expect(row.locator('.snip')).toHaveText('No.');
  await inOrder(row, ['.from', '.cnt-badge', '.date']);
  await press(pev.page, `.conv[data-thread="${await row.getAttribute('data-thread')}"]`);
  await expect(pev.page.locator('.card')).toHaveCount(2);
  await scrollCards(pev.page, 'top');
  const first = pev.page.locator('.card').first();
  await expect(first.locator('.ch-snip')).toHaveText('Pay␇ now, or else');
  const text = (await first.locator('.ch-snip').textContent()) ?? '';
  expect(['\u202e', '\u200b', '\u0007'].some((c) => text.includes(c))).toBe(false);
  await inOrder(first, ['.ch-name', '.ch-date']);
  expect((await boxes(first, ['.ch-snip']))[0]!.isolated).toBe(true);
});

test('from a result: "N messages · M matching" as the row says, snippets on matching cards, and the newest match expanded', async ({
  pev,
}) => {
  const { root, pairs } = exportOf('snip-search', [
    { id: 'I1', time: T0 + 100, subject: 'Studio', body: 'Attached is the invoice for March.' },
    { id: 'I2', time: T0 + 200, subject: 'Re: Studio', body: 'Thanks!', replyTo: 'I1', from: KIM },
    {
      id: 'I3',
      time: T0 + 300,
      subject: 'Re: Studio',
      body: 'Here is the updated invoice.',
      replyTo: 'I1',
    },
    { id: 'I4', time: T0 + 400, subject: 'Re: Studio', body: 'Paid.', replyTo: 'I1', from: KIM },
    // Two matching messages at the same time: the higher rowid opens.
    { id: 'T1', time: T0 + 50, subject: 'Tie', body: 'invoice one' },
    { id: 'T2', time: T0 + 50, subject: 'Re: Tie', body: 'invoice two', replyTo: 'T1' },
  ]);
  await openBodiesHeld(pev, root, pairs);
  await releaseBodies(pev, pairs);

  await typeText(pev.page, 'invoice');
  const results = pev.page.locator('.conv.result');
  await expect(results).toHaveCount(2);
  const studio = results.filter({ hasText: 'Studio' });
  await expect(studio.locator('.match-n')).toHaveText('2 matching');
  await studio.dispatchEvent('click');
  await expect(pev.page.locator('.cv-head .chip.count')).toHaveText('4 messages · 2 matching');
  const shown = await cardsState(pev);
  // The newest matching message expands, though the newest message doesn't match.
  const [i1, i2, i3, i4] = shown.cards.map((c) => c.rowid);
  expect(shown.expanded).toBe(i3);
  expect(Number(await studio.getAttribute('data-rowid'))).toBe(i3);
  expect(shown.cards.map((c) => c.matched)).toEqual([true, false, true, false]);
  expect(shown.count).toMatchObject({ total: 4, matching: 2 });
  // A matching card shows the search's snippet, marked; the others their lead.
  const card = (rowid: number | undefined) => pev.page.locator(`.card[data-rowid="${rowid}"]`);
  await scrollCards(pev.page, 'top');
  await expect(card(i1).locator('.ch-snip mark')).toHaveText(['invoice']);
  await expect(card(i1).locator('.ch-snip')).toHaveText('Attached is the invoice for March.');
  await expect(card(i1)).toHaveAttribute('data-match', '1');
  await expect(card(i2).locator('.ch-snip')).toHaveText('Thanks!');
  await expect(card(i2).locator('.ch-snip mark')).toHaveCount(0);
  await scrollCards(pev.page, 'end');
  await expect(card(i4).locator('.ch-snip')).toHaveText('Paid.');
  await expect(card(i4)).toHaveAttribute('data-match', '0');

  // The tie: the higher rowid expands.
  await results.filter({ hasText: 'Tie' }).dispatchEvent('click');
  await expect
    .poll(async () => {
      const s = await cardsState(pev);
      return s.cards.length === 2 && s.cards[0]!.time === s.cards[1]!.time ? s : null;
    })
    .not.toBeNull();
  const tie = await cardsState(pev);
  expect(tie.expanded).toBe(Math.max(...tie.cards.map((c) => c.rowid)));
  await expect(pev.page.locator('.cv-head .chip.count')).toHaveText('2 messages · 2 matching');

  // Picking a list row leaves the search: the header counts messages only.
  await typeText(pev.page, '');
  const listRow = pev.page.locator('.conv:not(.result)').filter({ hasText: 'Studio' });
  await press(pev.page, `.conv[data-thread="${await listRow.getAttribute('data-thread')}"]`);
  await expect(pev.page.locator('.cv-head .chip.count')).toHaveText('4 messages');
});

test('a read held in core while a write lands brings N and M from its own snapshot', async ({
  pev,
}) => {
  // Every body matches; which ones are indexed decides how many do.
  const messages: Msg[] = [1, 2, 3, 4].map((i) => ({
    id: `H${i}`,
    time: T0 + 100 * i,
    subject: i === 1 ? 'Studio' : 'Re: Studio',
    body: `invoice number ${i} ${FILLER}`,
    ...(i === 1 ? {} : { replyTo: 'H1' }),
  }));
  const { root, pairs } = exportOf('snip-held', messages);
  await openBodiesHeld(pev, root, pairs, ONE_BODY);
  await releaseBody(pev, 1);
  await releaseBody(pev, 2);

  await typeText(pev.page, 'invoice');
  const result = pev.page.locator('.conv.result');
  await expect(result).toHaveCount(1);
  await expect(result.locator('.match-n')).toHaveText('2 matching');
  await result.dispatchEvent('click');
  const head = pev.page.locator('.cv-head .chip.count');
  await expect(head).toHaveText('4 messages · 2 matching');
  const before = await cardsState(pev);
  expect(before.cards.filter((c) => c.matched)).toHaveLength(2);

  // A read of the cards reaches core and waits there.
  await pev.main('holdCards', before.expanded);
  await pev.shell('refreshCards', []);
  await expect.poll(() => pev.main<number>('heldCards')).toBe(1);
  // Meanwhile one more body is indexed: a third message matches.
  await releaseBody(pev, 3);
  // The read goes on, in the snapshot after the write.
  expect(await pev.main<number>('holdCards', null)).toBe(1);
  await expect(head).toHaveText('4 messages · 3 matching');
  const after = await cardsState(pev);
  expect(after.count!.rev).toBeGreaterThan(before.count!.rev);
  // N and M agree with the cards of the same answer: the whole conversation is in the window.
  expect(after.count).toMatchObject({ total: after.cards.length, matching: 3 });
  expect(after.cards.filter((c) => c.matched)).toHaveLength(3);
  // And with a result row for the index as it is now.
  const page = (await ask<SearchPage>(pev, {
    op: 'search',
    queryId: 9_999,
    text: 'invoice',
    sort: 'date',
    after: null,
  }))!.answer;
  expect(page.rows.find((r) => r.threadId === after.threadId)!.matching).toBe(3);
});
