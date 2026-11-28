// SPDX-License-Identifier: AGPL-3.0-or-later
// Subjects and names are mail data. In the folder list, the search results,
// the conversation, and the reader's header and Details, a format character
// can't reorder or hide text, a control shows as a symbol, each value is an
// isolated run of text, and a right-to-left subject reads as it was written.

import { realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import type { IndexProgress, IndexTotals } from '../../src/shared/index-types';
import { displayText } from '../../src/shared/header-text';
import { writeExport } from '../exports';
import { testDir } from '../paths';
import { writeMessage } from '../thread-export';
import { expect, test, type PevApp } from './app';

type Answer<T> = { answer: T; progress: IndexProgress } | null;

const ask = <T>(pev: PevApp, query: unknown) => pev.main<Answer<T>>('indexQuery', query);

// A right-to-left override starts the subject and the name, a zero-width
// space sits inside the subject, and the name holds a control character.
const HOSTILE_SUBJECT = '\u202eQuarterly\u200b report';
const HOSTILE_NAME = '\u202eEve\u0007 Mallory';
const SUBJECT = 'Quarterly report';
const NAME = 'Eve␇ Mallory';
// A right-to-left subject with a zero-width non-joiner inside a word, and a
// name with an emoji sequence joined by zero-width joiners: both stay whole.
const RTL_SUBJECT = 'سلام، می\u200cخواهم بیایم';
const FAMILY_NAME = 'Ava 👨\u200d👩\u200d👧';
const RAW = ['\u202e', '\u200b', '\u0007'];

/** Whether `text` still holds one of `chars`. */
const holds = (text: string | null, chars = RAW) => chars.some((c) => (text ?? '').includes(c));

/** Hidden windows get no frames to click in: events are sent directly. */
const press = (page: Page, selector: string) => page.locator(selector).dispatchEvent('click');

function typeText(page: Page, text: string): Promise<void> {
  return page.evaluate((t) => {
    const box = document.querySelector<HTMLInputElement>('.search-box');
    if (!box) throw new Error('no search box');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(box, t);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
}

interface Box {
  left: number;
  right: number;
  isolated: boolean;
}

/** Each selector's box in `scope`, and whether it is an isolated run of text. */
function boxes(scope: Locator, selectors: string[]): Promise<Box[]> {
  return scope.evaluate((el, all) => {
    return all.map((s) => {
      const part = el.querySelector<HTMLElement>(s);
      if (!part) throw new Error(`no ${s}`);
      const box = part.getBoundingClientRect();
      return {
        left: box.left,
        right: box.right,
        isolated: getComputedStyle(part).unicodeBidi === 'isolate',
      };
    });
  }, selectors);
}

/** The boxes sit left to right, without overlap, and each text one is isolated. */
function inOrder(found: Box[], texts: number): void {
  for (let i = 1; i < found.length; i += 1) {
    expect(found[i]!.left).toBeGreaterThanOrEqual(found[i - 1]!.right);
  }
  expect(found.slice(0, texts).map((b) => b.isolated)).toEqual(Array(texts).fill(true));
}

/** The hostile conversation's row: cleaned name and subject, in order. */
async function hostileRow(row: Locator): Promise<void> {
  await expect(row.locator('.from')).toHaveText(NAME);
  await expect(row.locator('.from')).toHaveAttribute('title', NAME);
  await expect(row.locator('.t')).toHaveText(SUBJECT);
  await expect(row.locator('.t')).toHaveAttribute('title', SUBJECT);
  await expect(row.locator('.cnt-badge')).toHaveText('2');
  expect(holds(await row.textContent())).toBe(false);
  inOrder(await boxes(row, ['.from', '.cnt-badge', '.date']), 1);
  expect((await boxes(row, ['.t']))[0]!.isolated).toBe(true);
}

/** The right-to-left conversation's row: its text whole, in order. */
async function rtlRow(row: Locator): Promise<void> {
  await expect(row.locator('.t')).toHaveText(RTL_SUBJECT);
  await expect(row.locator('.from')).toHaveText(FAMILY_NAME);
  inOrder(await boxes(row, ['.from', '.date']), 1);
  expect((await boxes(row, ['.t']))[0]!.isolated).toBe(true);
}

test('in the list, the results and the conversation, subjects and names are cleaned and keep their row in order', async ({
  pev,
}) => {
  const root = realpathSync(testDir('mail-text'));
  const base = writeExport(root, { seed: 74, messages: 0 });
  const t0 = 1_780_000_000;
  const hostile = { name: HOSTILE_NAME, address: 'eve@example.com' };
  const common = { labels: ['0', '5'], body: 'Hello.' };
  writeMessage(base.run, 'H1', {
    ...common,
    time: t0,
    subject: HOSTILE_SUBJECT,
    from: hostile,
    messageId: 'h1@example.com',
    references: [],
  });
  writeMessage(base.run, 'H2', {
    ...common,
    time: t0 + 60,
    subject: HOSTILE_SUBJECT,
    from: hostile,
    messageId: 'h2@example.com',
    references: ['h1@example.com'],
  });
  writeMessage(base.run, 'R1', {
    ...common,
    time: t0 + 120,
    subject: RTL_SUBJECT,
    from: { name: FAMILY_NAME, address: 'ava@example.com' },
    messageId: 'r1@example.com',
    references: [],
  });
  await pev.main('queuePick', root, 'bm1');
  await pev.shell('chooseFolder', []);
  await expect
    .poll(async () => (await ask<IndexTotals>(pev, { op: 'totals' }))?.progress, {
      timeout: 20_000,
    })
    .toMatchObject({ phase: 'done', loaded: 3, total: 3, failed: 0 });

  // The folder list.
  const list = pev.page.locator('.conv:not(.result)');
  await expect(list).toHaveCount(2);
  await hostileRow(list.filter({ hasText: SUBJECT }));
  await rtlRow(list.filter({ hasNotText: SUBJECT }));

  // The search results.
  await typeText(pev.page, 'Quarterly');
  const results = pev.page.locator('.conv.result');
  await expect(results).toHaveCount(1);
  await hostileRow(results.first());
  await typeText(pev.page, '');
  await expect(results).toHaveCount(0);

  // The conversation: its header and each card's name.
  const row = list.filter({ hasText: SUBJECT });
  const thread = await row.getAttribute('data-thread');
  await press(pev.page, `.conv[data-thread="${thread}"]`);
  const head = pev.page.locator('.cv-head .rp-subject');
  await expect(head).toHaveText(SUBJECT);
  expect((await boxes(pev.page.locator('.cv-head'), ['.rp-subject']))[0]!.isolated).toBe(true);
  const cards = pev.page.locator('.card');
  await expect(cards).toHaveCount(2);
  for (const card of await cards.all()) {
    await expect(card.locator('.ch-name')).toHaveText(NAME);
    await expect(card.locator('.ch-name')).toHaveAttribute('title', 'eve@example.com');
    inOrder(await boxes(card, ['.ch-name', '.ch-date']), 1);
  }
  expect(holds(await pev.page.locator('.cv-head').textContent())).toBe(false);
  const windows = await pev.main<Array<{ visible: boolean; focused: boolean }>>('windowState');
  expect(windows.filter((w) => w.visible || w.focused)).toEqual([]);
});

// The parser drops controls from address names but keeps them in the
// subject, so here the control is in the subject, with a tab. The To line
// names one recipient behind an isolate and one with an emoji sequence.
const READER_EML = [
  'From: "\u202eEve Mallory" <eve@example.com>',
  'To: "\u2067Bob\u2069" <bob@example.com>, "Ava 👨\u200d👩\u200d👧" <ava@example.com>',
  `Subject: ${HOSTILE_SUBJECT}\u0007\t2026`,
  'Date: Wed, 25 Nov 2026 08:02:11 +0100',
  'Message-ID: <reader-text@example.com>',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Hello.',
  '',
].join('\r\n');

interface ShownHeaders {
  view: { url: string; headers: { subject: string; from: string; to: string } } | null;
  pending: boolean;
}

test("the reader's header and Details show the subject, the names and the recipients cleaned", async ({
  pev,
}) => {
  const root = realpathSync(testDir('mail-text-reader'));
  writeFileSync(join(root, 'reader.eml'), READER_EML);
  const opened = await pev.main<{ ok: boolean }>('readerSource', root, [
    [1, { file: 'reader.eml' }],
  ]);
  expect(opened.ok).toBe(true);
  await pev.shell('openInReader', [1]);
  await expect
    .poll(async () => {
      const r = await pev.shell<ShownHeaders>('reader');
      const src = await pev.page.locator('.rp-frame').getAttribute('src');
      return !r.pending && r.view !== null && src === r.view.url;
    })
    .toBe(true);
  const { view } = await pev.shell<ShownHeaders>('reader');
  // The raw values still hold the format and control characters.
  expect(RAW.every((c) => view!.headers.subject.includes(c))).toBe(true);
  expect(view!.headers.subject).toContain('\t');
  expect(view!.headers.from).toContain('\u202e');
  expect(view!.headers.to).toContain('\u2067');

  const pane = pev.page.locator('.rp');
  await expect(pane.locator('.rp-subject')).toHaveText(`${SUBJECT}\u2407 2026`);
  await expect(pane.locator('.rp-name')).toHaveText('Eve Mallory');
  await expect(pane.locator('.rp-addr')).toHaveText('<eve@example.com>');
  await expect(pane.locator('.rp-to')).toHaveText(`to ${displayText(view!.headers.to)}`);
  await expect(pane.locator('.rp-to')).toContainText('Bob');
  await expect(pane.locator('.rp-to')).toContainText('Ava 👨\u200d👩\u200d👧');
  inOrder(await boxes(pane, ['.rp-name', '.rp-date']), 1);
  const isolated = await boxes(pane, ['.rp-subject', '.rp-addr', '.rp-to']);
  expect(isolated.map((b) => b.isolated)).toEqual([true, true, true]);
  expect(holds(await pane.locator('.rp-head').textContent())).toBe(false);
  expect(holds(await pane.locator('.rp-sender').textContent())).toBe(false);
  const isolates = ['\u2067', '\u2069'];
  expect(holds(await pane.locator('.rp-who').textContent(), [...RAW, ...isolates])).toBe(false);

  // Details: the same cleaner, by the Details rule.
  await press(pev.page, '.rp .rp-linkish');
  const dd = pane.locator('.rp-details dd');
  await expect(dd.nth(0)).toContainText('Eve Mallory');
  await expect(dd.nth(0)).toContainText('<eve@example.com>');
  await expect(dd.nth(0)).not.toContainText('\u202e');
  await expect(dd.nth(1)).not.toContainText('\u2067');
  await expect(dd.nth(1)).toContainText('Bob');
  const windows = await pev.main<Array<{ visible: boolean; focused: boolean }>>('windowState');
  expect(windows.filter((w) => w.visible || w.focused)).toEqual([]);
});
