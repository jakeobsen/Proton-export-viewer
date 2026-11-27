// SPDX-License-Identifier: AGPL-3.0-or-later
// The conversation reader: a selected conversation shows a card per message
// from every folder, oldest first, with one expanded through the reader's one
// open path. Expanding another card, selecting another conversation or
// removing the card revokes the old view at once, even while the next parse
// is pending; at every step a window holds at most one body frame and one
// live token. A merge or split keeps the expansion, and a long conversation
// draws a bounded number of cards.

import { realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { CARD_HEIGHT } from '../../src/renderer/cards';
import type { RejectCode } from '../../src/shared/api';
import type {
  CardsWindow,
  IndexProgress,
  IndexTotals,
  ListRow,
  ListWindow,
} from '../../src/shared/index-types';
import type { Stamp } from '../../src/shared/sources';
import { writeExport } from '../exports';
import { testDir } from '../paths';
import { writeMessage, writeThreads, type ThreadSpec } from '../thread-export';
import { expect, test, type PevApp } from './app';

type Answer<T> = { answer: T; progress: IndexProgress } | null;

interface Reader {
  rowid: number | null;
  pending: boolean;
  view: { url: string } | null;
  refused: RejectCode | null;
}

interface Cards {
  shown: boolean;
  expanded: number | null;
  total: number;
  gone: boolean;
  ready: boolean;
}

/** All Mail: every conversation of the export. */
const ALL = '5';

const ask = <T>(pev: PevApp, query: unknown) => pev.main<Answer<T>>('indexQuery', query);
const reader = (pev: PevApp) => pev.shell<Reader>('reader');
const cardsState = (pev: PevApp) => pev.shell<Cards>('cards');
const status = async (pev: PevApp, url: string) =>
  (await pev.main<{ status: number }>('fetchIn', 1, url)).status;
const core = async (pev: PevApp, action: string) =>
  (await pev.main<{ value?: number }>('core', action)).value ?? 0;
const count = (pev: PevApp, code: string) => pev.logs('main').filter((l) => l.code === code).length;
const deniedCount = (pev: PevApp, reason: string) =>
  pev.logs('main').filter((l) => l.code === 'nav.window_open_denied' && l.data.reason === reason)
    .length;
const linkUrl = (url: string, id: string) =>
  `${url.replace('mail-body://', 'mail-asset://')}/${id}`;

/** Hidden windows get no frames to click in: events are sent directly. */
const press = (page: Page, selector: string) => page.locator(selector).dispatchEvent('click');
const pressRow = (pev: PevApp, row: ListRow) =>
  press(pev.page, `.conv[data-thread="${row.threadId}"]`);
const pressCard = (pev: PevApp, rowid: number) =>
  press(pev.page, `.card[data-rowid="${rowid}"] .card-h`);

async function phase1Done(pev: PevApp, total: number): Promise<void> {
  await expect
    .poll(async () => (await ask<IndexTotals>(pev, { op: 'totals' }))?.progress, {
      timeout: 30_000,
    })
    .toMatchObject({ phase: 'done', loaded: total, total });
}

async function showAll(pev: PevApp): Promise<void> {
  await press(pev.page, `[data-folder="${ALL}"]`);
  await expect(pev.page.locator(`[data-folder="${ALL}"]`)).toHaveAttribute('aria-current', 'true');
}

async function openThreads(pev: PevApp, name: string, threads: ThreadSpec[], bookmark = 'bm1') {
  const root = realpathSync(testDir(name));
  const written = writeThreads(root, { seed: 71, threads });
  await pev.main('queuePick', root, bookmark);
  await pev.shell('chooseFolder', []);
  await phase1Done(pev, written.pairs);
  await showAll(pev);
  return written;
}

/** The conversations in All Mail, newest first. */
async function rows(pev: PevApp): Promise<ListRow[]> {
  const answer = await ask<ListWindow>(pev, {
    op: 'window',
    labelId: ALL,
    anchor: { index: 0 },
    before: 0,
    after: 50,
    selected: null,
  });
  return answer?.answer.rows ?? [];
}

/** The row of the conversation with `n` messages. */
async function rowOf(pev: PevApp, n: number): Promise<ListRow> {
  const row = (await rows(pev)).find((r) => r.count === n);
  if (!row) throw new Error(`no conversation of ${n}`);
  return row;
}

/** The rowids of a conversation's messages, oldest first. */
async function cardIds(pev: PevApp, rowid: number): Promise<number[]> {
  const answer = await ask<CardsWindow>(pev, {
    op: 'cards',
    follow: [rowid],
    threadId: null,
    anchor: { index: 0 },
    before: 0,
    after: 200,
  });
  return answer!.answer.cards.map((c) => c.rowid);
}

/** At most one body frame and one live token in the window, by every record there is. */
async function oneView(pev: PevApp): Promise<{ frames: number; live: number }> {
  const inTree = (await pev.shell<string[]>('readerFrames')).length;
  const bodyFrames = pev.page.frames().filter((f) => f.url().startsWith('mail-body:')).length;
  const live = await pev.main<number>('liveViews', 1);
  expect(inTree).toBeLessThanOrEqual(1);
  expect(bodyFrames).toBeLessThanOrEqual(1);
  expect(live).toBeLessThanOrEqual(1);
  return { frames: inTree, live };
}

/** Waits until the expanded card shows message `rowid` in its frame; returns the view's URL. */
async function expanded(pev: PevApp, rowid: number): Promise<string> {
  await expect
    .poll(async () => {
      const r = await reader(pev);
      const src = await pev.page
        .locator(`.card.expanded[data-rowid="${rowid}"] .rp-frame`)
        .getAttribute('src', { timeout: 1000 })
        .catch(() => null);
      return r.rowid === rowid && !r.pending && r.view !== null && src === r.view.url;
    })
    .toBe(true);
  const url = (await reader(pev)).view!.url;
  await pev.bodyFrame(url);
  expect(await oneView(pev)).toEqual({ frames: 1, live: 1 });
  return url;
}

/** The reader has started an open of `rowid`, and core holds it. */
async function pendingIn(pev: PevApp, rowid: number, held: number): Promise<void> {
  await expect.poll(async () => (await reader(pev)).rowid).toBe(rowid);
  await expect.poll(() => core(pev, 'held')).toBe(held);
  expect((await reader(pev)).pending).toBe(true);
  // Nothing of the old view is left while the parse is pending.
  expect(await oneView(pev)).toEqual({ frames: 0, live: 0 });
  await expect(pev.page.locator('.rp-frame')).toHaveCount(0);
}

async function checkHidden(pev: PevApp): Promise<void> {
  const windows = await pev.main<Array<{ visible: boolean; focused: boolean }>>('windowState');
  expect(windows.filter((w) => w.visible || w.focused)).toEqual([]);
  expect(await pev.main('windowEvents')).toEqual([]);
  expect(await pev.main('dialogCalls')).toEqual([]);
}

test('a conversation selected in a folder expands its newest message of all, after a tie on time', async ({
  pev,
}) => {
  // The first message is in the inbox and its reply only in Sent, at the same
  // time. Read and written in name order, the reply gets the later rowid: of
  // the two, it is the newest, and the last card.
  await pev.main('indexTestSettings', { readByName: true });
  const root = realpathSync(testDir('conv-split'));
  const written = writeThreads(root, {
    seed: 71,
    threads: [{ messages: 2, labels: (i) => (i === 0 ? ['0', ALL] : ['7', ALL]), tied: [1] }],
  });
  expect(written.threads[0]!.times[1]).toBe(written.threads[0]!.times[0]);
  await pev.main('queuePick', root, 'bm1');
  await pev.shell('chooseFolder', []);
  await phase1Done(pev, written.pairs);
  await press(pev.page, '[data-folder="0"]');
  await expect(pev.page.locator('[data-folder="0"]')).toHaveAttribute('aria-current', 'true');
  const inbox = await ask<ListWindow>(pev, {
    op: 'window',
    labelId: '0',
    anchor: { index: 0 },
    before: 0,
    after: 10,
    selected: null,
  });
  const row = inbox!.answer.rows[0]!;
  // In the inbox the row's anchor is the first message; the reply is the newest of all.
  expect(row.newestRowid).toBeGreaterThan(row.anchorRowid);
  expect(await cardIds(pev, row.anchorRowid)).toEqual([row.anchorRowid, row.newestRowid]);

  await pressRow(pev, row);
  await expanded(pev, row.newestRowid);
  expect((await cardsState(pev)).expanded).toBe(row.newestRowid);
  await checkHidden(pev);
});

test('a conversation shows every message from every folder, oldest first, with the newest expanded', async ({
  pev,
}) => {
  // Spam, Trash and Sent messages are in the conversation too.
  const labels = (i: number) =>
    i === 1 ? ['4', '5'] : i === 2 ? ['3', '5'] : i === 3 ? ['2', '5'] : ['0', '5'];
  await openThreads(pev, 'conv-cards', [
    { messages: 5, labels, subject: 'Trail plans' },
    { messages: 1 },
  ]);
  const row = await rowOf(pev, 5);
  const ids = await cardIds(pev, row.newestRowid);
  expect(ids).toHaveLength(5);
  // The conversation's newest message is its last card.
  expect(row.newestRowid).toBe(ids[4]);

  await pressRow(pev, row);
  await expanded(pev, ids[4]!);
  // The expanded card's header is at the top of the cards.
  await expect
    .poll(() =>
      pev.page.locator('.cv-scroll').evaluate((e) => {
        const card = e.querySelector('.card.expanded');
        return card
          ? Math.round(card.getBoundingClientRect().top - e.getBoundingClientRect().top)
          : null;
      }),
    )
    .toBe(0);
  await expect(pev.page.locator('.cv-head .rp-subject')).toHaveText('Trail plans');
  await expect(pev.page.locator('.cv-head .chip')).toHaveText('5 messages');
  const cards = pev.page.locator('.card');
  await expect(cards).toHaveCount(5);
  expect(
    await cards.evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-rowid')))),
  ).toEqual(ids);
  await expect(pev.page.locator('.card .ch-name')).toHaveText([
    'Sender 0',
    'Sender 1',
    'Sender 2',
    'Sender 3',
    'Sender 4',
  ]);
  // Badges: Spam and Trash only.
  await expect(pev.page.locator(`.card[data-rowid="${ids[1]}"] .pill`)).toHaveText(['Spam']);
  await expect(pev.page.locator(`.card[data-rowid="${ids[2]}"] .pill`)).toHaveText(['Trash']);
  for (const i of [0, 3, 4]) {
    await expect(pev.page.locator(`.card[data-rowid="${ids[i]}"] .pill`)).toHaveCount(0);
  }
  await expect(pev.page.locator('.card.expanded')).toHaveCount(1);
  await expect(pev.page.locator(`.card[data-rowid="${ids[4]}"] .card-h`)).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(pev.page.locator('.card .ch-date').first()).not.toHaveText('');
  // No size channel into the frame: the body scrolls inside its own frame.
  const frameBox = await pev.page
    .locator('.card.expanded .rp-body')
    .evaluate((e) => e.clientHeight);
  const pane = await pev.page.locator('.cv-scroll').evaluate((e) => e.clientHeight);
  expect(Math.abs(frameBox - Math.max(160, pane))).toBeLessThanOrEqual(2);
  await checkHidden(pev);
});

test('expanding another card revokes the previous view, with one frame and one token at each step', async ({
  pev,
}) => {
  await openThreads(pev, 'conv-expand', [{ messages: 4 }, { messages: 1 }]);
  const row = await rowOf(pev, 4);
  const ids = await cardIds(pev, row.newestRowid);
  await pressRow(pev, row);
  const newest = await expanded(pev, ids[3]!);

  await pressCard(pev, ids[0]!);
  const oldest = await expanded(pev, ids[0]!);
  expect(await status(pev, newest)).toBe(404);
  expect(await status(pev, oldest)).toBe(200);
  await expect(pev.page.locator('.card.expanded')).toHaveCount(1);
  await expect(pev.page.locator(`.card[data-rowid="${ids[3]}"]`)).not.toHaveClass(/expanded/);

  // A click on the expanded card's header opens nothing again.
  const installed = count(pev, 'view.installed');
  await pressCard(pev, ids[0]!);
  await pev.page.waitForTimeout(300);
  expect(count(pev, 'view.installed')).toBe(installed);
  expect(await status(pev, oldest)).toBe(200);

  // A plain-text message: plain text is what shows, and the HTML switch is off.
  await expect(pev.page.locator('.card.expanded .rp-plain')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(pev.page.locator('.card.expanded .rp-html')).toBeDisabled();
  await checkHidden(pev);
});

test('a pending expansion superseded by another card or another conversation: the old token is 404 and its frame gone at once', async ({
  pev,
}) => {
  await openThreads(pev, 'conv-pending', [{ messages: 4 }, { messages: 1 }]);
  const row = await rowOf(pev, 4);
  const single = await rowOf(pev, 1);
  const ids = await cardIds(pev, row.newestRowid);
  await pressRow(pev, row);
  const first = await expanded(pev, ids[3]!);
  const installed = count(pev, 'view.installed');

  // Core holds every read: each expansion stays pending.
  await core(pev, 'hold');
  await pressCard(pev, ids[1]!);
  await pendingIn(pev, ids[1]!, 1);
  expect(await status(pev, first)).toBe(404);

  // Another card while that one is pending.
  await pressCard(pev, ids[2]!);
  await expect.poll(async () => (await reader(pev)).rowid).toBe(ids[2]);
  await expect.poll(() => core(pev, 'held')).toBeGreaterThanOrEqual(1);
  expect(await oneView(pev)).toEqual({ frames: 0, live: 0 });
  await expect(pev.page.locator(`.card[data-rowid="${ids[2]}"]`)).toHaveClass(/expanded/);
  await expect(pev.page.locator('.card.expanded')).toHaveCount(1);

  // Another conversation from the list while that is pending.
  await pressRow(pev, single);
  await expect.poll(async () => (await reader(pev)).rowid).toBe(single.newestRowid);
  await expect(pev.page.locator('.card')).toHaveCount(1);
  expect(await oneView(pev)).toEqual({ frames: 0, live: 0 });

  // Let everything through: only the last one installs.
  await core(pev, 'release');
  await expanded(pev, single.newestRowid);
  expect(count(pev, 'view.installed')).toBe(installed + 1);
  expect(await status(pev, first)).toBe(404);
  await pev.page.waitForTimeout(300);
  expect(await oneView(pev)).toEqual({ frames: 1, live: 1 });
  expect(count(pev, 'view.installed')).toBe(installed + 1);
  await checkHidden(pev);
});

test('a link in a superseded view opens no dialog; the expanded one does', async ({ pev }) => {
  await openThreads(pev, 'conv-links', [{ messages: 3 }]);
  const row = await rowOf(pev, 3);
  const ids = await cardIds(pev, row.newestRowid);
  await pressRow(pev, row);
  const first = await expanded(pev, ids[2]!);

  // The next expansion is pending: the old view's link goes nowhere.
  await core(pev, 'hold');
  await pressCard(pev, ids[0]!);
  await pendingIn(pev, ids[0]!, 1);
  await pev.shell('windowOpen', [linkUrl(first, 'l1')]);
  await expect.poll(() => deniedCount(pev, 'unknown_token')).toBe(1);

  // Once it shows, its own link opens the dialog; the old one still doesn't.
  await core(pev, 'release');
  const second = await expanded(pev, ids[0]!);
  await pev.shell('windowOpen', [linkUrl(first, 'l1')]);
  await expect.poll(() => deniedCount(pev, 'unknown_token')).toBe(2);
  await pev.shell('windowOpen', [linkUrl(second, 'l1')]);
  await expect(pev.page.locator('.link-dialog')).toHaveCount(1);
  const shown = await pev.main<Array<{ url: string }>>('linkDialogs');
  expect(shown.map((s) => s.url)).toEqual(['https://example.com/c0/m0']);
  expect(await pev.main('externalCalls')).toEqual([]);
  await checkHidden(pev);
});

/**
 * Opens a second export, deletes the given messages' files from the first,
 * and opens the first again from its index with phase 1's writes held, so
 * its list and cards show the messages until the writes are let through.
 */
async function reopenWithHeldRemovals(
  pev: PevApp,
  run: string,
  remove: string[],
  pairs: number,
  options: { keepEml?: boolean } = {},
): Promise<void> {
  const first = await pev.main<Stamp>('sourceStamp');
  // The other export's writes go through.
  await pev.main('indexTestSettings', null);
  const other = realpathSync(testDir('conv-other'));
  const written = writeExport(other, { seed: 72, messages: 3 });
  await pev.main('queuePick', other, 'bm2');
  await pev.shell('chooseFolder', []);
  await phase1Done(pev, written.pairs);
  for (const id of remove) {
    // An .eml left without its metadata is no message, but can still be read.
    if (!options.keepEml) rmSync(join(run, `${id}.eml`));
    rmSync(join(run, `${id}.metadata.json`));
  }
  await pev.main('indexTestSettings', { batchPairs: 1, holdWrites: true, readByName: true });
  await pev.shell('openExport', [first.sourceKey]);
  await expect
    .poll(async () => (await pev.main<Stamp>('sourceStamp')).sourceKey)
    .toBe(first.sourceKey);
  // The index from before is shown while its changes wait.
  await expect
    .poll(async () => (await rows(pev)).reduce((n, r) => n + r.count, 0), { timeout: 20_000 })
    .toBe(pairs);
  await showAll(pev);
}

test('a pending card removed by the index opens the nearest card instead; with none left, the conversation is gone', async ({
  pev,
}) => {
  const written = await openThreads(pev, 'conv-removed', [{ messages: 4 }, { messages: 1 }]);
  const four = written.threads[0]!;
  const one = written.threads[1]!;
  // The second message of the four, and the only one of the other.
  await reopenWithHeldRemovals(pev, written.run, [four.ids[1]!, one.ids[0]!], written.pairs);

  const row = await rowOf(pev, 4);
  const ids = await cardIds(pev, row.newestRowid);
  await pressRow(pev, row);
  const newest = await expanded(pev, ids[3]!);
  const installed = count(pev, 'view.installed');

  // The doomed card's open is pending when the index removes it.
  await core(pev, 'hold');
  await pressCard(pev, ids[1]!);
  await pendingIn(pev, ids[1]!, 1);
  expect(await status(pev, newest)).toBe(404);
  await pev.main('releaseWrites', null);
  // The nearest card, the next newer one, takes its place.
  await expect.poll(async () => (await cardsState(pev)).expanded, { timeout: 20_000 }).toBe(ids[2]);
  await expect(pev.page.locator(`.card[data-rowid="${ids[1]}"]`)).toHaveCount(0);
  await expect(pev.page.locator('.card')).toHaveCount(3);
  await core(pev, 'release');
  await expanded(pev, ids[2]!);
  // The removed card's open installed nothing.
  expect(count(pev, 'view.installed')).toBe(installed + 1);
  await expect(pev.page.locator('.cv-head .chip')).toHaveText('3 messages');
  await checkHidden(pev);
});

test('a pending card removed with no card left installs nothing and says the message is gone', async ({
  pev,
}) => {
  const written = await openThreads(pev, 'conv-none-left', [{ messages: 3 }, { messages: 1 }]);
  const one = written.threads[1]!;
  // Its message file stays, so the open that is under way can finish its parse.
  await reopenWithHeldRemovals(pev, written.run, [one.ids[0]!], written.pairs, { keepEml: true });

  const row = await rowOf(pev, 1);
  const installed = count(pev, 'view.installed');
  const stale = () =>
    pev.logs('main').filter((l) => l.code === 'open.stale' && l.data.reason === 'open_id').length;
  const ended = () => stale() + count(pev, 'view.installed');
  const before = { stale: stale(), ended: ended() };
  // Core holds the open once its message file is open, before the parse.
  await core(pev, 'hold-opened');
  await pressRow(pev, row);
  await expect.poll(() => core(pev, 'held-opened')).toBe(1);
  expect((await reader(pev)).pending).toBe(true);
  expect(await oneView(pev)).toEqual({ frames: 0, live: 0 });
  await pev.main('releaseWrites', null);
  await expect.poll(async () => (await cardsState(pev)).gone, { timeout: 20_000 }).toBe(true);
  await expect(pev.page.locator('.reader .rp-state')).toHaveText('Message no longer in the export');
  await expect.poll(() => pev.main<number>('liveViews', 1)).toBe(0);
  // Its parse finishes after that and succeeds: main installs nothing for it.
  expect(await core(pev, 'release-opened')).toBe(1);
  await expect.poll(ended).toBe(before.ended + 1);
  expect(stale()).toBe(before.stale + 1);
  expect(count(pev, 'view.installed')).toBe(installed);
  expect(await oneView(pev)).toEqual({ frames: 0, live: 0 });
  expect((await reader(pev)).view).toBeNull();
  await checkHidden(pev);
});

test('a merge or a split keeps the expanded card and its view', async ({ pev }) => {
  // A: two messages; B: one; C links both, so the three are one conversation.
  const root = realpathSync(testDir('conv-merge'));
  const base = writeExport(root, { seed: 73, messages: 0 });
  const t0 = 1_780_000_000;
  const from = { name: 'Sam', address: 'sam@example.com' };
  const pair = (id: string, minutes: number, messageId: string, references: string[]) =>
    writeMessage(base.run, id, {
      time: t0 + minutes * 60,
      subject: id,
      from,
      labels: ['0', '5'],
      messageId,
      references,
      body: `Body of ${id}.`,
    });
  pair('A1', 0, 'a1@example.com', []);
  pair('A2', 1, 'a2@example.com', ['a1@example.com']);
  pair('B1', 2, 'b1@example.com', []);
  pair('C1', 3, 'c1@example.com', ['a1@example.com', 'b1@example.com']);
  await pev.main('indexTestSettings', { batchPairs: 1, holdWrites: true, readByName: true });
  await pev.main('queuePick', root, 'bm1');
  await pev.shell('chooseFolder', []);
  await expect.poll(() => pev.main<number>('heldWrites')).toBeGreaterThan(0);
  // A1, A2 and B1: two conversations.
  await pev.main('releaseWrites', 3);
  await expect.poll(async () => (await rows(pev)).length, { timeout: 20_000 }).toBe(2);
  await showAll(pev);
  const b = await rowOf(pev, 1);
  await pressRow(pev, b);
  const view = await expanded(pev, b.newestRowid);
  await expect(pev.page.locator('.card')).toHaveCount(1);
  const installed = count(pev, 'view.installed');

  // C1 merges B into A: B1 stays expanded, with the same view.
  await pev.main('releaseWrites', null);
  await phase1Done(pev, 4);
  await expect(pev.page.locator('.card')).toHaveCount(4);
  await expect(pev.page.locator('.cv-head .chip')).toHaveText('4 messages');
  expect((await cardsState(pev)).expanded).toBe(b.newestRowid);
  expect((await reader(pev)).view?.url).toBe(view);
  expect(await status(pev, view)).toBe(200);
  expect(count(pev, 'view.installed')).toBe(installed);

  // C1 goes again: the conversation splits, and B1 stays expanded on its own.
  await reopenWithHeldRemovals(pev, base.run, ['C1'], 4);
  const merged = await rowOf(pev, 4);
  const ids = await cardIds(pev, merged.newestRowid);
  await pressRow(pev, merged);
  // The newest message, C1, has no file any more: its card says so.
  await expect.poll(async () => (await reader(pev)).refused).toBe('eml_missing');
  expect((await reader(pev)).rowid).toBe(ids[3]);
  await expect(pev.page.locator('.card.expanded .rp-state')).toHaveText('Message file missing');
  await pressCard(pev, b.newestRowid);
  const again = await expanded(pev, b.newestRowid);
  const before = count(pev, 'view.installed');
  await pev.main('releaseWrites', null);
  await expect.poll(async () => (await cardsState(pev)).total, { timeout: 20_000 }).toBe(1);
  await expect(pev.page.locator('.card')).toHaveCount(1);
  expect((await cardsState(pev)).expanded).toBe(b.newestRowid);
  expect((await reader(pev)).view?.url).toBe(again);
  expect(await status(pev, again)).toBe(200);
  expect(count(pev, 'view.installed')).toBe(before);
  await checkHidden(pev);
});

test('a conversation of 1,200 messages draws a bounded number of cards', async ({ pev }) => {
  test.setTimeout(120_000);
  await openThreads(pev, 'conv-long', [{ messages: 1200 }]);
  const row = await rowOf(pev, 1200);
  await pressRow(pev, row);
  await expanded(pev, row.newestRowid);
  await expect(pev.page.locator('.cv-head .chip')).toHaveText('1,200 messages');
  const drawn = () => pev.page.locator('.card:not(.placeholder)').count();
  expect(await drawn()).toBeLessThan(60);
  expect(await drawn()).toBeGreaterThan(0);
  // Scrolled a little way up, the expanded card is out of view but still held:
  // it stays drawn, with the same frame, so nothing loads again.
  const frame = pev.page.locator(`.card.expanded[data-rowid="${row.newestRowid}"] .rp-frame`);
  await frame.evaluate((e) => e.setAttribute('data-kept', 'yes'));
  await pev.page.locator('.cv-scroll').evaluate((e, by) => {
    e.scrollTop -= by;
    e.dispatchEvent(new Event('scroll'));
  }, 20 * CARD_HEIGHT);
  await expect
    .poll(() =>
      pev.page.locator('.cv-slot').evaluateAll((slots) => {
        const box = slots[0]?.parentElement?.parentElement?.getBoundingClientRect();
        const card = slots.find((s) => s.querySelector('.card.expanded'));
        return box && card ? card.getBoundingClientRect().top >= box.bottom : null;
      }),
    )
    .toBe(true);
  await expect(frame).toHaveAttribute('data-kept', 'yes');
  expect(await oneView(pev)).toEqual({ frames: 1, live: 1 });
  // The expanded card is the newest, at the end; scrolling to the top reads the oldest.
  await pev.page.locator('.cv-scroll').evaluate((e) => {
    e.scrollTop = 0;
    e.dispatchEvent(new Event('scroll'));
  });
  await expect(pev.page.locator('.card .ch-name').first()).toHaveText('Sender 0');
  expect(await drawn()).toBeLessThan(60);
  // The expansion and its view stay as they were; its frame may be out of the drawn range.
  expect((await cardsState(pev)).expanded).toBe(row.newestRowid);
  expect((await oneView(pev)).live).toBe(1);
  await checkHidden(pev);
});
