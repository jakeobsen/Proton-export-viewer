// SPDX-License-Identifier: AGPL-3.0-or-later
// The search box and its results in the shell: one search per typing pause,
// only the latest answer shown, operators, both sorts, pages, conversations
// that come again on a later page left out (also when bodies are indexed
// between pages), the partial line, snippets as text, and a result opening in
// the reader.

import { readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type {
  IndexProgress,
  IndexTotals,
  ListWindow,
  SearchPage,
} from '../../src/shared/index-types';
import type { Stamp } from '../../src/shared/sources';
import { writeExport } from '../exports';
import { testDir } from '../paths';
import { expect, test, type PevApp } from './app';

type Answer<T> = { answer: T; progress: IndexProgress } | null;
const ask = <T>(pev: PevApp, query: unknown) => pev.main<Answer<T>>('indexQuery', query);

interface SearchState {
  text: string;
  resultsFor: string | null;
  active: boolean;
  sort: 'date' | 'relevance';
  searching: boolean;
  failed: boolean;
  ranked: boolean;
  total: number | null;
  coverage: { indexed: number; pending: number; total: number } | null;
  selected: { threadId: number; rowid: number } | null;
  skipped: number;
  threadIds: number[];
}

const state = (pev: PevApp) => pev.shell<SearchState>('search');

/**
 * A message of a made-up export: its ID, subject and time, the message it
 * replies to, and its body text (the template message's otherwise).
 */
interface Spec {
  id: string;
  subject: string;
  time: number;
  replyTo?: string;
  sender?: string;
  labels?: string[];
  body?: string;
}

/** A plain-text message file with this body. */
function plainMessage(text: string): Buffer {
  return Buffer.from(
    [
      `From: <${SENDER}>`,
      'Subject: s',
      'Content-Type: text/plain; charset=utf-8',
      '',
      text,
      '',
    ].join('\r\n'),
  );
}

const SENDER = 'sam@example.com';

/** Writes an export of exactly these messages, from one generated pair as a template. */
function craft(name: string, specs: Spec[]): { root: string; run: string; pairs: number } {
  const root = realpathSync(testDir(name));
  const written = writeExport(root, { seed: 71, messages: 1 });
  const template = readdirSync(written.run).find((n) => n.endsWith('.metadata.json'))!;
  const id = template.slice(0, -'.metadata.json'.length);
  const doc = JSON.parse(readFileSync(join(written.run, template), 'utf8')) as {
    Payload: Record<string, unknown>;
  };
  const eml = join(written.run, `${id}.eml`);
  const body = readFileSync(eml);
  rmSync(join(written.run, template));
  rmSync(eml);
  for (const spec of specs) write(written.run, doc, body, spec);
  return { root, run: written.run, pairs: specs.length };
}

function write(
  run: string,
  doc: { Payload: Record<string, unknown> },
  body: Buffer,
  spec: Spec,
): void {
  const sender = spec.sender ?? SENDER;
  const payload = {
    ...doc.Payload,
    ID: spec.id,
    ExternalID: '',
    Subject: spec.subject,
    Time: spec.time,
    Headers:
      `Message-ID: <${spec.id}@example.com>\r\n` +
      (spec.replyTo ? `In-Reply-To: <${spec.replyTo}@example.com>\r\n` : ''),
    LabelIDs: spec.labels ?? ['0', '5'],
    Unread: 0,
    Sender: { Name: sender.split('@')[0], Address: sender },
    ToList: [{ Name: 'Kim', Address: 'kim@example.com' }],
    CCList: [],
    BCCList: [],
    NumAttachments: 0,
    Attachments: [],
  };
  writeFileSync(
    join(run, `${spec.id}.metadata.json`),
    JSON.stringify({ ...doc, Payload: payload }),
  );
  writeFileSync(
    join(run, `${spec.id}.eml`),
    spec.body === undefined ? body : plainMessage(spec.body),
  );
}

/** Changes the subject of messages already written. */
function resubject(run: string, changes: Array<[string, string]>): void {
  for (const [id, subject] of changes) {
    const file = join(run, `${id}.metadata.json`);
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { Payload: Record<string, unknown> };
    doc.Payload.Subject = subject;
    writeFileSync(file, JSON.stringify(doc));
  }
}

async function phase1Done(pev: PevApp, total: number): Promise<void> {
  await expect
    .poll(async () => (await ask<IndexTotals>(pev, { op: 'totals' }))?.progress, {
      timeout: 20_000,
    })
    .toMatchObject({ phase: 'done', loaded: total, total, failed: 0 });
}

/** Waits until phase 2 has read every message file. */
async function bodiesDone(pev: PevApp, total: number): Promise<void> {
  await expect
    .poll(async () => (await ask<IndexTotals>(pev, { op: 'totals' }))?.progress, {
      timeout: 30_000,
    })
    .toMatchObject({ bodyPhase: 'done', bodiesDone: total, bodiesTotal: total, bodiesFailed: 0 });
}

async function open(pev: PevApp, root: string, pairs: number, bookmark = 'bm1'): Promise<void> {
  await pev.main('queuePick', root, bookmark);
  await pev.shell('chooseFolder', []);
  await phase1Done(pev, pairs);
}

/**
 * Opens `root` with no body indexed yet: writes are held, and phase 1's go
 * through one at a time until it is done. Phase 2's stay held.
 */
async function openBodiesHeld(pev: PevApp, root: string, pairs: number): Promise<void> {
  await pev.main('indexTestSettings', { holdWrites: true });
  await pev.main('queuePick', root, 'bm1');
  await pev.shell('chooseFolder', []);
  await expect
    .poll(
      async () => {
        const progress = (await ask<IndexTotals>(pev, { op: 'totals' }))?.progress;
        if (progress?.phase === 'done' && progress.loaded === pairs) return true;
        if ((await pev.main<number>('heldWrites')) > 0) await pev.main('releaseWrites', 1);
        return false;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  // Later cores index as usual.
  await pev.main('indexTestSettings', null);
}

/** Hidden windows get no key events from the system: the box's value is set and its input event sent. */
function typeText(page: Page, text: string): Promise<void> {
  return page.evaluate((t) => {
    const box = document.querySelector<HTMLInputElement>('.search-box');
    if (!box) throw new Error('no search box');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(box, t);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
}

/** Types each text in turn, `gap` ms apart, in the page's own clock. */
function typeSlowly(page: Page, texts: string[], gap: number): Promise<void> {
  return page.evaluate(
    async ({ texts: all, gap: ms }) => {
      const box = document.querySelector<HTMLInputElement>('.search-box')!;
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      for (const t of all) {
        set.call(box, t);
        box.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, ms));
      }
    },
    { texts, gap },
  );
}

/** Picks a sort in the results' select, as its change event does. */
function chooseSort(page: Page, sort: 'date' | 'relevance'): Promise<void> {
  return page.evaluate((value) => {
    const select = document.querySelector<HTMLSelectElement>('.results select.sort');
    if (!select) throw new Error('no sort');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }, sort);
}

/** Waits until the search for `text` has its answer. */
async function settled(pev: PevApp, text: string): Promise<SearchState> {
  await expect
    .poll(async () => {
      const s = await state(pev);
      return s.resultsFor === text && s.active && !s.searching;
    })
    .toBe(true);
  return state(pev);
}

async function scrollResults(page: Page, top: number): Promise<void> {
  await page.evaluate((y) => {
    const el = document.querySelector<HTMLElement>('.results .list-scroll');
    if (!el) throw new Error('no results');
    el.scrollTop = y;
    el.dispatchEvent(new Event('scroll'));
  }, top);
}

/** Scrolls the results to their end until no more rows come. */
async function scrollToEnd(pev: PevApp, rows: number): Promise<SearchState> {
  await expect
    .poll(
      async () => {
        await scrollResults(pev.page, 1e9);
        return (await state(pev)).threadIds.length;
      },
      { timeout: 20_000 },
    )
    .toBe(rows);
  return state(pev);
}

/** Every conversation of a folder, newest first, read a window of up to 200 at a time. */
async function folderRows(pev: PevApp, labelId: string) {
  const rows: Array<ListWindow['rows'][number] & { subject: string }> = [];
  for (;;) {
    const window_ = (await ask<ListWindow>(pev, {
      op: 'window',
      labelId,
      anchor: { index: rows.length },
      before: 0,
      after: 200,
      selected: null,
    }))!.answer;
    rows.push(...window_.rows.map((row, i) => ({ ...row, subject: window_.details[i]!.subject })));
    if (window_.rows.length === 0 || rows.length >= window_.total) return rows;
  }
}

/** The conversation whose earliest subject is this. */
async function threadBySubject(pev: PevApp, subject: string): Promise<number> {
  const row = (await folderRows(pev, '5')).find((r) => r.subject === subject);
  if (!row) throw new Error(`no conversation "${subject}"`);
  return row.threadId;
}

/** Twelve conversations: six about a zebra, three about a zebu and three about a yak. */
function animals(name: string) {
  const specs: Spec[] = [];
  for (let i = 0; i < 6; i += 1)
    specs.push({ id: `Z${i}`, subject: `Zebra crossing ${i}`, time: 1_700_000_000 + i });
  for (let i = 0; i < 3; i += 1)
    specs.push({ id: `U${i}`, subject: `Zebu farm ${i}`, time: 1_700_000_100 + i });
  for (let i = 0; i < 3; i += 1)
    specs.push({ id: `Y${i}`, subject: `Yak notes ${i}`, time: 1_700_000_200 + i });
  return craft(name, specs);
}

test('a search runs once typing pauses, and its results replace the list until the box is cleared', async ({
  pev,
}) => {
  const { root, pairs } = animals('sbox-typing');
  await openBodiesHeld(pev, root, pairs);
  await expect(pev.page.locator('.list-head .cnt')).toHaveText('12 conversations');
  const before = await pev.main<number>('coreSearches');

  // Five keystrokes 40 ms apart: one search, for the last text.
  await typeSlowly(pev.page, ['z', 'ze', 'zeb', 'zebr', 'zebra'], 40);
  const shown = await settled(pev, 'zebra');
  expect(shown.total).toBe(6);
  expect((await pev.main<number>('coreSearches')) - before).toBe(1);
  await expect(pev.page.locator('.results .cnt')).toHaveText('6 conversations');
  const rows = pev.page.locator('.results .conv[data-thread]');
  await expect(rows).toHaveCount(6);
  // Each row: the list's row, with its snippet's match marked.
  await expect(rows.first().locator('.subj .t')).toHaveText('Zebra crossing 5');
  await expect(rows.first().locator('.from')).toHaveText('sam');
  await expect(rows.first().locator('.snip mark')).toHaveText(['Zebra']);
  await expect(pev.page.locator('.results .match-n')).toHaveCount(0);
  // Before any body is indexed, the results say they are partial.
  await expect(pev.page.locator('.results .partial')).toHaveText(
    'Partial results: 0 of 12 bodies indexed.',
  );
  await expect(pev.page.locator('.list:not(.results)')).toHaveCount(0);

  // Escape clears the box, and the folder's list is back.
  await pev.page.locator('.search-box').dispatchEvent('keydown', { key: 'Escape', bubbles: true });
  await expect(pev.page.locator('.results')).toHaveCount(0);
  await expect(pev.page.locator('.list-head .cnt')).toHaveText('12 conversations');
  expect(await state(pev)).toMatchObject({ text: '', active: false, threadIds: [] });

  // So does emptying it.
  await typeText(pev.page, 'yak');
  expect((await settled(pev, 'yak')).total).toBe(3);
  await typeText(pev.page, '');
  await expect(pev.page.locator('.results')).toHaveCount(0);
  await expect(pev.page.locator('.list-head .cnt')).toHaveText('12 conversations');

  // No query text reaches a log.
  for (const file of ['main', 'core', 'renderer'] as const) {
    const text = JSON.stringify(pev.logs(file)).toLowerCase();
    expect(text, file).not.toContain('zebra');
    expect(text, file).not.toContain('yak');
  }
});

test('a search that gets no answer says so, and the box takes at most 1,000 characters', async ({
  pev,
}) => {
  const { root, pairs } = animals('sbox-failed');
  await open(pev, root, pairs);
  await expect(pev.page.locator('.search-box')).toHaveAttribute('maxlength', '1000');
  // Text past the limit, set as typing could not: main refuses it, and no answer comes.
  await typeText(pev.page, 'zebra '.repeat(200));
  await expect.poll(async () => (await state(pev)).failed).toBe(true);
  await expect(pev.page.locator('.results .no-results')).toHaveText("Couldn't search");
  // The next search that gets an answer takes the line's place.
  await typeText(pev.page, 'zebra');
  expect((await settled(pev, 'zebra')).total).toBe(6);
  await expect(pev.page.locator('.results .no-results')).toHaveCount(0);
  await expect(pev.page.locator('.results .conv[data-thread]')).toHaveCount(6);
});

test('only the latest search installs: an older answer that comes late is dropped, and a waiting one is replaced', async ({
  pev,
}) => {
  const { root, pairs } = animals('sbox-latest');
  await open(pev, root, pairs);
  const zebras = await Promise.all(
    [0, 1, 2, 3, 4, 5].map((i) => threadBySubject(pev, `Zebra crossing ${i}`)),
  );
  const zebus = await Promise.all([0, 1, 2].map((i) => threadBySubject(pev, `Zebu farm ${i}`)));
  const yaks = await Promise.all([0, 1, 2].map((i) => threadBySubject(pev, `Yak notes ${i}`)));
  const before = await pev.main<number>('coreSearches');
  // Every row drawn in the results, from the first search on.
  await pev.page.evaluate(() => {
    const seen = new Set<number>();
    (window as unknown as { __drawn: Set<number> }).__drawn = seen;
    new MutationObserver(() => {
      for (const el of document.querySelectorAll<HTMLElement>('.results .conv[data-thread]')) {
        seen.add(Number(el.dataset.thread));
      }
    }).observe(document.body, { childList: true, subtree: true });
  });

  await pev.main('holdSearches');
  // The first search reaches core and is held there.
  await typeText(pev.page, 'zebra');
  await expect.poll(() => pev.main<number>('heldSearches')).toBe(1);
  // The second waits behind it in main; the third takes its place.
  await typeText(pev.page, 'zebu');
  await expect.poll(async () => (await state(pev)).text).toBe('zebu');
  await pev.page.waitForTimeout(400);
  await typeText(pev.page, 'yak');
  await pev.page.waitForTimeout(400);
  expect(await state(pev)).toMatchObject({ text: 'yak', searching: true, threadIds: [] });
  expect(await pev.main<number>('releaseSearches')).toBe(1);

  const shown = await settled(pev, 'yak');
  expect(new Set(shown.threadIds)).toEqual(new Set(yaks));
  const drawn = await pev.page.evaluate(() => [
    ...(window as unknown as { __drawn: Set<number> }).__drawn,
  ]);
  expect(drawn.filter((t) => zebras.includes(t) || zebus.includes(t))).toEqual([]);
  // The zebra search ran and its answer was dropped; the zebu one never reached core.
  expect((await pev.main<number>('coreSearches')) - before).toBe(2);
});

test('operators, both sorts, "N matching" and snippets as text, and a result opens in the reader', async ({
  pev,
}) => {
  const t = 1_700_000_000;
  // Short bodies of the same length, so ranks follow the subjects; D1 matches in its body only.
  const body = 'see you soon';
  const { root, pairs } = craft('sbox-operators', [
    { id: 'A1', subject: 'Invoice for March', time: t + 100, body },
    { id: 'A2', subject: 'Re: Invoice for March', time: t + 200, replyTo: 'A1', body },
    {
      id: 'B1',
      subject: 'invoice invoice invoice',
      time: t + 50,
      sender: 'lee@example.org',
      body,
    },
    { id: 'C1', subject: 'Lunch', time: t + 300, body },
    {
      id: 'D1',
      subject: 'Draft <b>bold</b> notes',
      time: t + 150,
      labels: ['0', '5', '10'],
      body: 'Invoice <b>bold</b> draft',
    },
    { id: 'E1', subject: 'Invoice E', time: t + 10, body },
    { id: 'E2', subject: 'Re: lunch plans', time: t + 20, replyTo: 'E1', body },
  ]);
  await open(pev, root, pairs);
  await bodiesDone(pev, pairs);
  const [a, b, c, d, e] = await Promise.all(
    [
      'Invoice for March',
      'invoice invoice invoice',
      'Lunch',
      'Draft <b>bold</b> notes',
      'Invoice E',
    ].map((s) => threadBySubject(pev, s)),
  );

  // By date: the newest matching message's date orders the rows.
  await typeText(pev.page, 'invoice');
  const byDate = await settled(pev, 'invoice');
  expect(byDate.threadIds).toEqual([a, d, b, e]);
  expect(byDate).toMatchObject({ sort: 'date', ranked: true, total: 4 });
  const rowA = pev.page.locator(`.results .conv[data-thread="${a}"]`);
  await expect(rowA.locator('.match-n')).toHaveText('2 matching');
  await expect(rowA.locator('.cnt-badge')).toHaveText('2');
  await expect(rowA.locator('.subj .t')).toHaveText('Invoice for March');
  // Markup in mail stays text: in the subject, and in a snippet of the body.
  const rowD = pev.page.locator(`.results .conv[data-thread="${d}"]`);
  await expect(rowD.locator('.subj .t')).toHaveText('Draft <b>bold</b> notes');
  await expect(rowD.locator('.snip')).toContainText('Invoice <b>bold</b> draft');
  await expect(rowD.locator('.snip b, .subj b')).toHaveCount(0);
  await expect(rowD.locator('.snip mark')).toHaveText(['Invoice']);

  // By relevance: the conversation that says it three times comes first.
  await chooseSort(pev.page, 'relevance');
  await expect.poll(async () => (await state(pev)).sort).toBe('relevance');
  const byRank = await settled(pev, 'invoice');
  expect(byRank.threadIds[0]).toBe(b);
  expect(new Set(byRank.threadIds)).toEqual(new Set([a, b, d, e]));

  // Operators.
  const only = async (text: string) => {
    await typeText(pev.page, text);
    return (await settled(pev, text)).threadIds;
  };
  expect(await only('invoice is:starred')).toEqual([d]);
  expect(await only('from:lee@example.org')).toEqual([b]);
  // Only filters: by date, and relevance isn't offered.
  expect((await state(pev)).ranked).toBe(false);
  await expect(pev.page.locator('.results select.sort option')).toHaveText(['Newest first']);
  await expect(pev.page.locator('.results select.sort')).toBeDisabled();
  // Only a negated word: every other message, so the conversation with a reply about lunch too.
  expect(await only('-invoice')).toEqual([c, e]);
  expect(await only('subject:"for march"')).toEqual([a]);
  expect(await only('nothingmatchesthis')).toEqual([]);
  await expect(pev.page.locator('.results .no-results')).toHaveText('No results');
  await expect(pev.page.locator('.results .cnt')).toHaveText('0 conversations');

  // A result opens its newest matching message, through the reader's own path.
  await chooseSort(pev.page, 'date');
  await typeText(pev.page, 'invoice');
  await settled(pev, 'invoice');
  const rowE = pev.page.locator(`.results .conv[data-thread="${e}"]`);
  const anchorE = Number(await rowE.getAttribute('data-rowid'));
  const listE = (await folderRows(pev, '5')).find((r) => r.threadId === e)!;
  // Its newest message doesn't match, so the result opens another one.
  expect(anchorE).not.toBe(listE.newestRowid);
  await rowE.dispatchEvent('click');
  await expect(rowE).toHaveAttribute('aria-selected', 'true');
  const reader = () => pev.shell<{ rowid: number | null; view: { url: string } | null }>('reader');
  const cards = () =>
    pev.shell<{ shown: boolean; threadId: number | null; expanded: number | null }>('cards');
  await expect.poll(async () => (await reader()).view?.url ?? null).not.toBeNull();
  expect((await reader()).rowid).toBe(anchorE);
  // It opens as its conversation's cards, with the matching message expanded.
  expect(await cards()).toMatchObject({ shown: true, threadId: e, expanded: anchorE });
  // Clearing the box closes what a result opened; the list has nothing selected.
  await typeText(pev.page, '');
  await expect.poll(async () => (await reader()).rowid).toBeNull();
  expect((await cards()).shown).toBe(false);
  expect(await pev.shell('listSelection')).toBeNull();
});

test('results come a page at a time in both sorts, and rows past the first get their snippets when shown', async ({
  pev,
}) => {
  const specs: Spec[] = Array.from({ length: 230 }, (_, i) => ({
    id: `R${String(i).padStart(3, '0')}`,
    subject: `Zebra report ${i}${' notes'.repeat(i % 5)}`,
    time: 1_700_000_000 + i,
  }));
  const { root, pairs } = craft('sbox-pages', specs);
  await openBodiesHeld(pev, root, pairs);
  await typeText(pev.page, 'zebra');
  const first = await settled(pev, 'zebra');
  expect(first.total).toBe(230);
  expect(first.threadIds).toHaveLength(200);
  await expect(pev.page.locator('.results .partial')).toHaveText(
    'Partial results: 0 of 230 bodies indexed.',
  );

  // A row past the first 50 came without a snippet and gets one once on screen.
  const late = first.threadIds[120]!;
  await scrollResults(pev.page, 115 * 102);
  await expect(pev.page.locator(`.results .conv[data-thread="${late}"] .snip mark`)).toHaveText([
    'Zebra',
  ]);

  const byDate = await scrollToEnd(pev, 230);
  expect(new Set(byDate.threadIds).size).toBe(230);
  expect(byDate.skipped).toBe(0);
  const times = (await folderRows(pev, '5')).map((r) => r.threadId);
  expect(byDate.threadIds.slice(0, 200)).toEqual(times.slice(0, 200));

  await chooseSort(pev.page, 'relevance');
  await expect.poll(async () => (await state(pev)).sort).toBe('relevance');
  await settled(pev, 'zebra');
  expect((await state(pev)).threadIds).toHaveLength(200);
  const byRank = await scrollToEnd(pev, 230);
  expect(new Set(byRank.threadIds).size).toBe(230);
});

/**
 * Opens `root` again in a new core, with its phase 1 writes held, so a
 * search sees the index as it was before the files changed.
 */
async function reopenHeld(pev: PevApp, key: string, other: string): Promise<void> {
  await open(pev, other, 1, 'bm2');
  await pev.main('indexTestSettings', { batchPairs: 1000, holdWrites: true, readByName: true });
  await pev.shell('openExport', [key]);
  await expect.poll(() => pev.main<number>('heldWrites'), { timeout: 20_000 }).toBeGreaterThan(0);
}

test('by date, a conversation moved behind the cursor between pages is left out, and a page of only those moves on', async ({
  pev,
}) => {
  const t = 1_700_000_000;
  const specs: Spec[] = [];
  // 200 conversations, each with an older and a newer match; five more in between.
  for (let i = 0; i < 200; i += 1) {
    specs.push({
      id: `O${String(i).padStart(3, '0')}`,
      subject: `Zebra old ${i}`,
      time: t + 5000 - i,
    });
    specs.push({
      id: `N${String(i).padStart(3, '0')}`,
      subject: `Zebra news ${i}`,
      time: t + 10_000 - i,
      replyTo: `O${String(i).padStart(3, '0')}`,
    });
  }
  for (let j = 0; j < 5; j += 1)
    specs.push({ id: `L${j}`, subject: `Zebra late ${j}`, time: t + 1000 - j });
  const { root, run, pairs } = craft('sbox-date-repeat', specs);
  const other = craft('sbox-date-other', [{ id: 'X1', subject: 'Other', time: t }]);
  await open(pev, root, pairs);
  const key = (await pev.main<Stamp>('sourceStamp')).sourceKey;
  const late = await Promise.all(
    [0, 1, 2, 3, 4].map((j) => threadBySubject(pev, `Zebra late ${j}`)),
  );

  // Every newer match stops matching: each conversation's newest match is its older one now.
  resubject(
    run,
    Array.from({ length: 200 }, (_, i) => [`N${String(i).padStart(3, '0')}`, `Lunch ${i}`]),
  );
  await reopenHeld(pev, key, other.root);

  // The first page is read before the change is written.
  await typeText(pev.page, 'zebra');
  const first = await settled(pev, 'zebra');
  expect(first.total).toBe(205);
  expect(first.threadIds).toHaveLength(200);
  expect(first.threadIds.some((t_) => late.includes(t_))).toBe(false);
  const firstPage = (await ask<SearchPage>(pev, {
    op: 'search',
    queryId: 1,
    text: 'zebra',
    sort: 'date',
    after: null,
  }))!.answer;
  const cursor = firstPage.next!;

  await pev.main('releaseWrites', null);
  await phase1Done(pev, pairs);
  // Core's second page now holds only conversations already shown.
  const second = (await ask<SearchPage>(pev, {
    op: 'search',
    queryId: 2,
    text: 'zebra',
    sort: 'date',
    after: cursor,
  }))!.answer;
  expect(second.rows).toHaveLength(200);
  expect(second.rows.every((r) => first.threadIds.includes(r.threadId))).toBe(true);

  // The shell leaves them out and still moves on to the five after them.
  const all = await scrollToEnd(pev, 205);
  expect(all.skipped).toBe(200);
  expect(new Set(all.threadIds).size).toBe(205);
  expect(all.threadIds.slice(200)).toEqual(late);
});

test('by relevance, a page read after more bodies are indexed shows no conversation twice', async ({
  pev,
}) => {
  const t = 1_700_000_000;
  const specs: Spec[] = [];
  for (let i = 0; i < 200; i += 1) {
    specs.push({
      id: `S${String(i).padStart(3, '0')}`,
      subject: 'zebra zebra',
      time: t + i,
      body: 'see you soon',
    });
  }
  // A long body that never says zebra: once indexed, its message ranks below every other.
  specs[0]!.body = 'lunch plans '.repeat(1500);
  for (let j = 0; j < 5; j += 1) {
    specs.push({
      id: `W${j}`,
      subject: `zebra weaker ${j} match`,
      time: t + 500 + j,
      body: 'notes '.repeat(30),
    });
  }
  const { root, pairs } = craft('sbox-rank-bodies', specs);
  await openBodiesHeld(pev, root, pairs);
  // The conversation with the long body, the only one dated t.
  const weakened = (await folderRows(pev, '5')).find((r) => r.time === t)!.threadId;

  // The first page is read before any body is indexed: all 200 strong matches.
  await typeText(pev.page, 'zebra');
  await settled(pev, 'zebra');
  await chooseSort(pev.page, 'relevance');
  await expect.poll(async () => (await state(pev)).sort).toBe('relevance');
  const first = await settled(pev, 'zebra');
  expect(first.threadIds).toHaveLength(200);
  expect(first.threadIds).toContain(weakened);
  const firstPage = (await ask<SearchPage>(pev, {
    op: 'search',
    queryId: 1,
    text: 'zebra',
    sort: 'relevance',
    after: null,
  }))!.answer;
  const cursor = firstPage.next!;

  await pev.main('releaseWrites', null);
  await bodiesDone(pev, pairs);
  // Core's second page now holds the conversation with the long body again.
  const second = (await ask<SearchPage>(pev, {
    op: 'search',
    queryId: 2,
    text: 'zebra',
    sort: 'relevance',
    after: cursor,
  }))!.answer;
  expect(second.rows.map((r) => r.threadId)).toContain(weakened);

  // The shell leaves it out, and shows the five weaker matches once each.
  const all = await scrollToEnd(pev, 205);
  expect(all.skipped).toBeGreaterThan(0);
  expect(new Set(all.threadIds).size).toBe(205);
  expect(all.threadIds.filter((t_) => t_ === weakened)).toHaveLength(1);
});

test('by relevance, a lone conversation changed while page 1 shows keeps its ID and shows once', async ({
  pev,
}) => {
  const t = 1_700_000_000;
  const specs: Spec[] = [];
  for (let i = 0; i < 200; i += 1) {
    specs.push({ id: `S${String(i).padStart(3, '0')}`, subject: 'zebra zebra', time: t + i });
  }
  for (let j = 0; j < 5; j += 1) {
    specs.push({ id: `W${j}`, subject: `zebra weaker ${j} match`, time: t + 500 + j });
  }
  const { root, run, pairs } = craft('sbox-rank-lone', specs);
  const other = craft('sbox-rank-lone-other', [{ id: 'X1', subject: 'Other', time: t }]);
  await open(pev, root, pairs);
  const key = (await pev.main<Stamp>('sourceStamp')).sourceKey;
  // S000 is the oldest message, and its conversation's only one.
  const rows = await folderRows(pev, '5');
  expect(rows).toHaveLength(205);
  const oldest = rows[rows.length - 1]!;
  expect(oldest).toMatchObject({ subject: 'zebra zebra', count: 1 });
  const lone = oldest.threadId;

  // Its only message now matches weakly: it is placed again, alone, and keeps
  // its conversation's ID.
  const weak = 'zebra with a long tail of other words that make it a weak match';
  resubject(run, [['S000', weak]]);
  await reopenHeld(pev, key, other.root);
  await typeText(pev.page, 'zebra');
  await settled(pev, 'zebra');
  await chooseSort(pev.page, 'relevance');
  await expect.poll(async () => (await state(pev)).sort).toBe('relevance');
  const first = await settled(pev, 'zebra');
  expect(first.threadIds).toHaveLength(200);
  expect(first.threadIds).toContain(lone);

  // Page 1 stays shown while the change is written; the next pages follow its cursor.
  await pev.main('releaseWrites', null);
  await phase1Done(pev, pairs);
  expect(await threadBySubject(pev, weak)).toBe(lone);
  const all = await scrollToEnd(pev, 205);
  // It came again on core's next page under the same ID, and was left out.
  expect(all.skipped).toBeGreaterThan(0);
  expect(new Set(all.threadIds).size).toBe(205);
  expect(all.threadIds.filter((t_) => t_ === lone)).toHaveLength(1);
});
test("by date, bodies indexed between pages that make shown conversations' newest match newer bring none of them again", async ({
  pev,
}) => {
  const t = 1_700_000_000;
  const specs: Spec[] = [];
  // 200 conversations: an older message that matches by its subject, and a
  // newer reply that matches only by its body.
  for (let i = 0; i < 200; i += 1) {
    const n = String(i).padStart(3, '0');
    specs.push({
      id: `O${n}`,
      subject: `Zebra old ${i}`,
      time: t + 5000 - i,
      body: 'see you soon',
    });
    specs.push({
      id: `N${n}`,
      subject: `Re: lunch ${i}`,
      time: t + 10_000 - i,
      replyTo: `O${n}`,
      body: `the zebra came back ${i}`,
    });
  }
  for (let j = 0; j < 5; j += 1)
    specs.push({
      id: `L${j}`,
      subject: `Zebra late ${j}`,
      time: t + 1000 - j,
      body: 'see you soon',
    });
  const { root, pairs } = craft('sbox-date-bodies', specs);
  await openBodiesHeld(pev, root, pairs);
  const late = await Promise.all(
    [0, 1, 2, 3, 4].map((j) => threadBySubject(pev, `Zebra late ${j}`)),
  );

  // The first page is read before any body is indexed: each conversation by its older message.
  await typeText(pev.page, 'zebra');
  const first = await settled(pev, 'zebra');
  expect(first.total).toBe(205);
  expect(first.threadIds).toHaveLength(200);
  expect(first.threadIds.some((t_) => late.includes(t_))).toBe(false);
  const before = (await ask<SearchPage>(pev, {
    op: 'search',
    queryId: 1,
    text: 'zebra',
    sort: 'date',
    after: null,
  }))!.answer;
  expect(before.rows[0]!.time).toBe(t + 5000);

  await pev.main('releaseWrites', null);
  await bodiesDone(pev, pairs);
  // Every reply's body matches now: each conversation's newest match is its reply.
  const after = (await ask<SearchPage>(pev, {
    op: 'search',
    queryId: 2,
    text: 'zebra',
    sort: 'date',
    after: null,
  }))!.answer;
  expect(after.rows[0]).toMatchObject({ time: t + 10_000, matching: 2 });
  const second = (await ask<SearchPage>(pev, {
    op: 'search',
    queryId: 3,
    text: 'zebra',
    sort: 'date',
    after: before.next,
  }))!.answer;
  expect(second.rows.map((r) => r.threadId)).toEqual(late);

  // The shell's next page brings only the five after them, with none left out.
  const all = await scrollToEnd(pev, 205);
  expect(all.skipped).toBe(0);
  expect(new Set(all.threadIds).size).toBe(205);
  expect(all.threadIds.slice(200)).toEqual(late);
});

test("the snippets channel takes a query ID and up to 50 conversations, for the window's current search", async ({
  pev,
}) => {
  const { root, pairs } = animals('sbox-snippets');
  await open(pev, root, pairs);
  const generation = (await pev.shell<{ generation: number }>('state')).generation;
  const invoke = (...args: unknown[]) =>
    pev.page.evaluate(
      (a) => window.__pevTestIpc.invoke('pev:search-snippets', ...a),
      args,
    ) as Promise<{ ok: boolean; code?: string; queryId?: number; snippets?: unknown[] }>;
  const search = (text: string) =>
    pev.page.evaluate(([t, g]) => window.pev.search({ text: t, sort: 'date', after: null }, g), [
      text,
      generation,
    ] as const);
  const zebra = await search('zebra');
  if (!zebra.ok) throw new Error('search failed');
  const threads = zebra.page.rows.map((r) => r.threadId);
  const ok = { queryId: zebra.queryId, threadIds: threads, generation };

  const invalid = { ok: false, code: 'invalid' };
  expect(await invoke({ ...ok, threadIds: [] })).toEqual(invalid);
  expect(await invoke({ ...ok, threadIds: Array.from({ length: 51 }, (_, i) => i + 1) })).toEqual(
    invalid,
  );
  expect(await invoke({ ...ok, threadIds: [0] })).toEqual(invalid);
  expect(await invoke({ ...ok, threadIds: ['1'] })).toEqual(invalid);
  expect(await invoke({ ...ok, queryId: 0 })).toEqual(invalid);
  expect(await invoke({ ...ok, text: 'yak' })).toEqual(invalid);
  expect(await invoke(ok, 'extra')).toEqual(invalid);
  expect(await invoke({ ...ok, generation: generation + 1 })).toEqual({
    ok: false,
    code: 'stale_generation',
  });

  // The current search's ID gives each conversation its best match's snippet.
  const answer = await invoke(ok);
  expect(answer).toMatchObject({ ok: true, queryId: zebra.queryId });
  expect(
    (answer.snippets as Array<{ threadId: number; snippet: { text: string } | null }>).map((s) => [
      s.threadId,
      s.snippet?.text.toLowerCase().includes('zebra'),
    ]),
  ).toEqual(threads.map((t) => [t, true]));
  // A query ID no search made yet, and one of an older search, are superseded.
  expect(await invoke({ ...ok, queryId: zebra.queryId + 1000 })).toEqual({
    ok: false,
    code: 'superseded',
  });
  const yak = await search('yak');
  if (!yak.ok) throw new Error('search failed');
  expect(await invoke(ok)).toEqual({ ok: false, code: 'superseded' });
  // Another request with the same text, as a later page or a sort makes, keeps its first ID current.
  const again = await search('yak');
  if (!again.ok) throw new Error('search failed');
  expect(again.queryId).toBeGreaterThan(yak.queryId);
  expect(await invoke({ ...ok, queryId: yak.queryId })).toMatchObject({ ok: true });
});

test('a search and a snippet request that core answers after the generation moved on are stale', async ({
  pev,
}) => {
  const { root, pairs } = animals('sbox-stale');
  await open(pev, root, pairs);
  const generation = (await pev.shell<{ generation: number }>('state')).generation;
  type Result = { ok: boolean; code?: string };
  // A first search names the query IDs that follow.
  const first = await pev.page.evaluate(
    (g) => window.pev.search({ text: 'yak', sort: 'date', after: null }, g),
    generation,
  );
  if (!first.ok) throw new Error('search failed');
  const before = await pev.main<number>('coreSearches');

  await pev.main('holdSearches');
  // A runs and is held in core; B, with the same text, waits behind it in main.
  await pev.page.evaluate((g) => {
    const w = window as unknown as Record<string, Promise<unknown>>;
    w.__a = window.pev.search({ text: 'zebra', sort: 'date', after: null }, g);
    w.__b = window.pev.search({ text: 'zebra', sort: 'relevance', after: null }, g);
  }, generation);
  await expect.poll(() => pev.main<number>('heldSearches')).toBe(1);
  // A snippet request for A's search is held in core too.
  await pev.page.evaluate(
    ([q, g]) => {
      (window as unknown as Record<string, Promise<unknown>>).__s = window.pev.searchSnippets(
        { queryId: q, threadIds: [1, 2] },
        g,
      );
    },
    [first.queryId + 1, generation] as const,
  );
  await expect.poll(() => pev.main<number>('heldSearches')).toBe(2);

  await pev.main('bumpGeneration');
  expect(await pev.main<number>('releaseSearches')).toBe(2);
  const results = await pev.page.evaluate(async () => {
    const w = window as unknown as Record<string, Promise<unknown>>;
    return Promise.all([w.__a, w.__b, w.__s]);
  });
  const stale = { ok: false, code: 'stale_generation' };
  expect(results as Result[]).toEqual([stale, stale, stale]);
  // B was checked when its turn came, and never reached core.
  expect((await pev.main<number>('coreSearches')) - before).toBe(1);
});
