// SPDX-License-Identifier: AGPL-3.0-or-later
// The open export in the shell: the sidebar with its folders, labels and
// unread counts; a folder's conversations with the list header and rows; the
// loading state, where rows that arrive never move the anchored row; and a
// selection that follows its message when its conversation is merged away.

import {
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { IndexProgress, IndexTotals, ListWindow, Sidebar } from '../../src/shared/index-types';
import { formatCount, listDate, participantsText } from '../../src/renderer/format';
import { writeExport } from '../exports';
import { testDir } from '../paths';
import { expect, test, type PevApp } from './app';

type Answer<T> = { answer: T; progress: IndexProgress } | null;

const ask = <T>(pev: PevApp, query: unknown) => pev.main<Answer<T>>('indexQuery', query);

async function progress(pev: PevApp): Promise<IndexProgress | undefined> {
  return (await ask<IndexTotals>(pev, { op: 'totals' }))?.progress;
}

async function phase1Done(pev: PevApp, total: number): Promise<void> {
  await expect
    .poll(() => progress(pev), { timeout: 20_000 })
    .toMatchObject({ phase: 'done', loaded: total, total, failed: 0 });
}

async function windowOf(pev: PevApp, labelId: string, after: number): Promise<ListWindow> {
  return (await ask<ListWindow>(pev, {
    op: 'window',
    labelId,
    anchor: { index: 0 },
    before: 0,
    after,
    selected: null,
  }))!.answer;
}

/** Hidden windows get no frames to click or scroll in: events are sent directly. */
const press = (page: Page, selector: string) => page.locator(selector).dispatchEvent('click');

async function scrollList(page: Page, top: number): Promise<void> {
  await page.evaluate((y) => {
    const el = document.querySelector<HTMLElement>('.list-scroll');
    if (!el) throw new Error('no list');
    el.scrollTop = y;
    el.dispatchEvent(new Event('scroll'));
  }, top);
}

/** The rows on screen: conversation, position and offset from the list's top edge. */
async function rowsOnScreen(page: Page) {
  return page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('.list-scroll')!;
    const edge = list.getBoundingClientRect().top;
    return [...list.querySelectorAll<HTMLElement>('.conv[data-thread]')]
      .map((el) => ({
        thread: Number(el.dataset.thread),
        rowid: Number(el.dataset.rowid),
        pos: Number(el.getAttribute('aria-posinset')),
        y: Math.round(el.getBoundingClientRect().top - edge),
        selected: el.getAttribute('aria-selected') === 'true',
      }))
      .filter((r) => r.y >= 0 && r.y < list.clientHeight)
      .sort((a, b) => a.y - b.y);
  });
}

const headerCount = (page: Page) => page.locator('.list-head .cnt').textContent();

test("the sidebar and the list show the export's folders, labels and conversations", async ({
  pev,
}) => {
  const root = realpathSync(testDir('list-show'));
  const written = writeExport(root, { seed: 41, messages: 80 });
  await pev.main('queuePick', root, 'bm1');
  await pev.shell('chooseFolder', []);
  await phase1Done(pev, written.pairs);
  const sidebar = (await ask<Sidebar>(pev, { op: 'sidebar' }))!.answer;
  const rows = new Map(sidebar.folders.map((f) => [f.id, f]));

  // The account and the export, at the top.
  await expect(pev.page.locator('.acct-box .export-account')).toHaveText(written.account);
  await expect(pev.page.locator('.acct-box .export-run')).toHaveText('Export 30 Jun 2025, 12:00');

  // System folders in their order, with fixed names; the last three only when used.
  const system: Array<[string, string]> = [
    ['0', 'Inbox'],
    ['16', 'Snoozed'],
    ['8', 'Drafts'],
    ['9', 'Outbox'],
    ['12', 'Scheduled'],
    ['7', 'Sent'],
    ['10', 'Starred'],
    ['6', 'Archive'],
    ['4', 'Spam'],
    ['3', 'Trash'],
    ['5', 'All Mail'],
  ];
  const shown = system.filter(
    ([id]) => !['9', '12', '16'].includes(id) || (rows.get(id)?.conversations ?? 0) > 0,
  );
  const firstGroup = pev.page.locator('.sidebar nav').first();
  await expect(firstGroup.locator('.nav-name')).toHaveText(shown.map(([, name]) => name));
  // Folders, then labels, each with its unread-conversation count.
  await expect(pev.page.locator('.sidebar .nav-h')).toHaveText(['Folders', 'Labels']);
  const items = await pev.page.locator('.sidebar .nav-item').evaluateAll((els) =>
    els.map((el) => ({
      id: el.getAttribute('data-folder')!,
      count: el.querySelector('.nav-count')?.textContent ?? null,
    })),
  );
  expect(items.length).toBe(
    shown.length + sidebar.folders.filter((f) => f.kind !== 'system').length,
  );
  for (const item of items) {
    const unread = rows.get(item.id)!.unread;
    expect(item.count, item.id).toBe(unread > 0 ? formatCount(unread) : null);
  }
  // Labels with a valid color show it.
  const colored = sidebar.folders.find((f) => f.kind === 'label' && f.color !== null)!;
  await expect(pev.page.locator(`.nav-item[data-folder="${colored.id}"] .dot`)).toHaveAttribute(
    'style',
    /background/,
  );

  // All Mail: the header and the newest rows, as the index has them.
  await press(pev.page, '.nav-item[data-folder="5"]');
  await expect(pev.page.locator('.list-head h2')).toHaveText('All Mail');
  const allMail = rows.get('5')!;
  await expect
    .poll(() => headerCount(pev.page))
    .toBe(
      `${formatCount(allMail.conversations)} conversations` +
        (allMail.unread > 0 ? ` · ${formatCount(allMail.unread)} unread` : ''),
    );
  const index = await windowOf(pev, '5', 6);
  const labels = new Map(
    sidebar.folders.filter((f) => f.kind === 'label').map((f) => [f.id, f.name]),
  );
  for (const [i, row] of index.rows.entries()) {
    const el = pev.page.locator(`.conv[data-thread="${row.threadId}"]`);
    const details = index.details[i]!;
    await expect(el).toHaveAttribute('aria-posinset', String(i + 1));
    await expect(el.locator('.from')).toHaveText(participantsText(details.participants));
    await expect(el.locator('.subj .t')).toHaveText(details.subject);
    await expect(el.locator('.date')).toHaveText(listDate(row.time));
    await expect(el.locator('.cnt-badge')).toHaveCount(row.count > 1 ? 1 : 0);
    if (row.count > 1) await expect(el.locator('.cnt-badge')).toHaveText(String(row.count));
    await expect(el.locator('.udot')).toHaveCount(row.unreadHere > 0 ? 1 : 0);
    await expect(el.locator('.clip')).toHaveCount(row.attachments ? 1 : 0);
    await expect(el.locator('.chip')).toHaveText(
      details.labelIds.filter((id) => labels.has(id)).map((id) => labels.get(id)!),
    );
  }

  // A selection shows on its row; the reader stays empty.
  const second = index.rows[1]!.threadId;
  await press(pev.page, `.conv[data-thread="${second}"]`);
  await expect(pev.page.locator(`.conv[data-thread="${second}"]`)).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(pev.page.locator('.conv[aria-selected="true"]')).toHaveCount(1);
  await expect(pev.page.locator('.reader iframe')).toHaveCount(0);
  // Done loading: no loading bar.
  await expect(pev.page.locator('.side-foot')).toHaveCount(0);
});

test('rows that arrive while the export loads never move the anchored row', async ({ pev }) => {
  const root = realpathSync(testDir('list-anchor'));
  const written = writeExport(root, { seed: 42, messages: 160 });
  // Read in name order, not the folder's order, which differs between file
  // systems: the names are random, so rows arrive above and below the anchor.
  await pev.main('indexTestSettings', { batchPairs: 10, holdWrites: true, readByName: true });
  await pev.main('queuePick', root, 'bm1');
  await pev.shell('chooseFolder', []);
  await expect.poll(() => pev.main<number>('heldWrites')).toBeGreaterThan(0);
  await pev.main('releaseWrites', 5);
  await expect.poll(async () => (await progress(pev))?.loaded).toBe(50);
  await expect(pev.page.locator('.side-foot .loading-text')).toHaveText(
    `Loading 50 of ${written.pairs}…`,
  );
  await press(pev.page, '.nav-item[data-folder="5"]');
  await expect.poll(() => headerCount(pev.page)).toMatch(/^\d+ conversations/);

  /**
   * Lets one more write through and waits until the list shows it: the row of
   * the conversation that holds message `rowid` is where the index puts it.
   * Returns that conversation; it changes when the conversation is merged.
   */
  const step = async (loaded: number, rowid: number): Promise<number> => {
    await pev.main('releaseWrites', 1);
    await expect.poll(async () => (await progress(pev))?.loaded).toBe(loaded);
    const at = (await ask<ListWindow>(pev, {
      op: 'window',
      labelId: '5',
      anchor: { rowid, index: 0 },
      before: 0,
      after: 1,
      selected: null,
    }))!.answer;
    expect(at.anchor).not.toBeNull();
    const thread = at.rows[0]!.threadId;
    await expect
      .poll(() => pev.page.locator(`.conv[data-thread="${thread}"]`).getAttribute('aria-posinset'))
      .toBe(String(at.anchor! + 1));
    return thread;
  };

  // The top row on screen is the anchor: scrolled down a little first.
  await scrollList(pev.page, 4 * 82);
  await expect.poll(async () => (await rowsOnScreen(pev.page))[0]?.pos).toBe(5);
  const anchor = (await rowsOnScreen(pev.page))[0]!;
  let moved = false;
  for (let loaded = 60; loaded <= 100; loaded += 10) {
    const thread = await step(loaded, anchor.rowid);
    const top = (await rowsOnScreen(pev.page))[0]!;
    expect(top.thread).toBe(thread);
    expect(Math.abs(top.y - anchor.y)).toBeLessThanOrEqual(1);
    if (top.pos > anchor.pos) moved = true;
  }
  // Rows did arrive above it.
  expect(moved).toBe(true);

  // A selected row on screen is the anchor.
  const chosen = (await rowsOnScreen(pev.page))[3]!;
  await press(pev.page, `.conv[data-thread="${chosen.thread}"]`);
  await expect.poll(async () => (await rowsOnScreen(pev.page))[3]?.selected).toBe(true);
  for (let loaded = 110; loaded <= 140; loaded += 10) {
    const thread = await step(loaded, chosen.rowid);
    const now = (await rowsOnScreen(pev.page)).find((r) => r.thread === thread)!;
    expect(now.selected).toBe(true);
    expect(Math.abs(now.y - chosen.y)).toBeLessThanOrEqual(1);
  }

  await pev.main('releaseWrites', null);
  await phase1Done(pev, written.pairs);
  await expect(pev.page.locator('.side-foot')).toHaveCount(0);
});

/** Rewrites a pair's metadata under a new ID, with its own headers, time and subject. */
function rewrite(
  run: string,
  from: string,
  to: string,
  headers: string,
  time: number,
  subject: string,
): void {
  const doc = JSON.parse(readFileSync(join(run, `${from}.metadata.json`), 'utf8')) as {
    Payload: Record<string, unknown>;
  };
  doc.Payload.ID = to;
  doc.Payload.Headers = headers;
  doc.Payload.Time = time;
  doc.Payload.Subject = subject;
  doc.Payload.LabelIDs = ['0', '5'];
  doc.Payload.Unread = 0;
  rmSync(join(run, `${from}.metadata.json`));
  writeFileSync(join(run, `${to}.metadata.json`), JSON.stringify(doc));
  renameSync(join(run, `${from}.eml`), join(run, `${to}.eml`));
}

test('a selected conversation that is merged away stays selected through its message', async ({
  pev,
}) => {
  const root = realpathSync(testDir('list-merge'));
  const written = writeExport(root, { seed: 43, messages: 4 });
  const ids = readdirSync(written.run)
    .filter((n) => n.endsWith('.metadata.json'))
    .map((n) => n.slice(0, -'.metadata.json'.length))
    .sort();
  const t0 = 1_750_000_000;
  // A: two messages; B: one; C links both, so B (the smaller) is merged into A.
  rewrite(written.run, ids[0]!, 'A1', 'Message-ID: <a1@example.com>\r\n', t0, 'Trip');
  rewrite(
    written.run,
    ids[1]!,
    'A2',
    'Message-ID: <a2@example.com>\r\nIn-Reply-To: <a1@example.com>\r\n',
    t0 + 3600,
    'Re: Trip',
  );
  rewrite(written.run, ids[2]!, 'B1', 'Message-ID: <b1@example.com>\r\n', t0 + 7200, 'Budget');
  rewrite(
    written.run,
    ids[3]!,
    'C1',
    'Message-ID: <c1@example.com>\r\nReferences: <a1@example.com> <b1@example.com>\r\n',
    t0 + 10_800,
    'Re: Trip and budget',
  );
  await pev.main('indexTestSettings', { batchPairs: 1, holdWrites: true, readByName: true });
  await pev.main('queuePick', root, 'bm1');
  await pev.shell('chooseFolder', []);
  await expect.poll(() => pev.main<number>('heldWrites')).toBeGreaterThan(0);
  // A1, A2 and B1: two conversations, B newest.
  await pev.main('releaseWrites', 3);
  await expect.poll(async () => (await progress(pev))?.loaded).toBe(3);
  await expect.poll(() => headerCount(pev.page)).toBe('2 conversations');
  const before = await windowOf(pev, '0', 5);
  const [b, a] = before.rows as [ListWindow['rows'][0], ListWindow['rows'][0]];
  expect([b.count, a.count]).toEqual([1, 2]);
  await press(pev.page, `.conv[data-thread="${b.threadId}"]`);
  await expect(pev.page.locator(`.conv[data-thread="${b.threadId}"]`)).toHaveAttribute(
    'aria-selected',
    'true',
  );

  // C1 arrives and merges B into A: B's conversation ID is gone.
  await pev.main('releaseWrites', null);
  await phase1Done(pev, 4);
  await expect.poll(() => headerCount(pev.page)).toBe('1 conversation');
  const after = await windowOf(pev, '0', 5);
  expect(after.rows.map((r) => [r.threadId, r.count])).toEqual([[a.threadId, 4]]);
  await expect(pev.page.locator(`.conv[data-thread="${b.threadId}"]`)).toHaveCount(0);
  await expect(pev.page.locator(`.conv[data-thread="${a.threadId}"]`)).toHaveAttribute(
    'aria-selected',
    'true',
  );
  // It is held by B1's message, which is in A now.
  const state = await pev.shell<{ rowid: number; threadId: number } | null>('listSelection');
  expect(state).toEqual({ rowid: b.anchorRowid, threadId: a.threadId });
  expect((await ask<number>(pev, { op: 'resolve', rowid: b.anchorRowid }))!.answer).toBe(
    a.threadId,
  );
});

test('the index channel checks its arguments and the generation', async ({ pev }) => {
  const root = realpathSync(testDir('list-channel'));
  const written = writeExport(root, { seed: 44, messages: 10 });
  await pev.main('queuePick', root, 'bm1');
  await pev.shell('chooseFolder', []);
  await phase1Done(pev, written.pairs);
  const generation = (await pev.shell<{ generation: number }>('state')).generation;
  const invoke = (arg: unknown, ...more: unknown[]) =>
    pev.page.evaluate(
      ([a, m]) =>
        (
          window as unknown as {
            __pevTestIpc: { invoke(c: string, ...x: unknown[]): Promise<unknown> };
          }
        ).__pevTestIpc.invoke('pev:index', a, ...(m as unknown[])),
      [arg, more] as const,
    );
  const window_ = {
    op: 'window',
    labelId: '5',
    anchor: { index: 0 },
    before: 0,
    after: 5,
    selected: null,
  };
  expect(await invoke({ query: { op: 'sidebar' }, generation })).toMatchObject({
    ok: true,
    generation,
  });
  expect(await invoke({ query: window_, generation })).toMatchObject({ ok: true });
  for (const bad of [
    { query: { op: 'totals' }, generation },
    { query: { op: 'page', labelId: '5', after: null }, generation },
    { query: { ...window_, after: 201 }, generation },
    { query: { ...window_, before: 101 }, generation },
    { query: { ...window_, labelId: '' }, generation },
    { query: { ...window_, labelId: 'x'.repeat(257) }, generation },
    { query: { ...window_, anchor: { index: -1 } }, generation },
    { query: { ...window_, anchor: { index: 0, path: '/' } }, generation },
    { query: { ...window_, selected: 0 }, generation },
    { query: window_, generation, extra: 1 },
    { query: window_ },
  ]) {
    expect(await invoke(bad), JSON.stringify(bad)).toEqual({ ok: false, code: 'invalid' });
  }
  expect(await invoke({ query: window_, generation }, 'extra')).toEqual({
    ok: false,
    code: 'invalid',
  });
  expect(await invoke({ query: window_, generation: generation + 1 })).toEqual({
    ok: false,
    code: 'stale_generation',
  });
});
