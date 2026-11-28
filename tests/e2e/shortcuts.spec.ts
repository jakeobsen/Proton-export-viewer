// SPDX-License-Identifier: AGPL-3.0-or-later
// Keyboard shortcuts and the theme: each shortcut on a generated export, the
// keys main passes on from the body frame (and only those), the overlay,
// Escape's order, keys typed in the search box, and the Theme setting in the
// shell and in a message's own dark-mode rules.

import { readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { RejectCode } from '../../src/shared/api';
import type {
  CardsWindow,
  IndexProgress,
  IndexTotals,
  ListRow,
  ListWindow,
} from '../../src/shared/index-types';
import { testDir } from '../paths';
import { writeThreads, type ThreadSpec } from '../thread-export';
import { expect, launch, test, type PevApp } from './app';

type Answer<T> = { answer: T; progress: IndexProgress } | null;

interface Reader {
  rowid: number | null;
  pending: boolean;
  view: { url: string; format: 'html' | 'plain' } | null;
  refused: RejectCode | null;
}

const INBOX = '0';
/** All Mail: every conversation of the export. */
const ALL = '5';

const ask = <T>(pev: PevApp, query: unknown) => pev.main<Answer<T>>('indexQuery', query);
const reader = (pev: PevApp) => pev.shell<Reader>('reader');
const count = (pev: PevApp, code: string) => pev.logs('main').filter((l) => l.code === code).length;

/** Hidden windows get no frames to click in: events are sent directly. */
const press = (page: Page, selector: string) => page.locator(selector).dispatchEvent('click');
const pressButton = (page: Page, name: string) =>
  page.getByRole('button', { name, exact: true }).dispatchEvent('click');

/** A key press only the shell's document sees, with what a real one can't easily carry. */
const keydown = (page: Page, selector: string, init: Record<string, unknown>) =>
  page.locator(selector).dispatchEvent('keydown', init);

async function phase1Done(pev: PevApp, total: number): Promise<void> {
  await expect
    .poll(async () => (await ask<IndexTotals>(pev, { op: 'totals' }))?.progress, {
      timeout: 30_000,
    })
    .toMatchObject({ phase: 'done', loaded: total, total });
}

const folderShown = (pev: PevApp, id: string) =>
  expect(pev.page.locator(`[data-folder="${id}"]`)).toHaveAttribute('aria-current', 'true');

async function showAll(pev: PevApp): Promise<void> {
  await press(pev.page, `[data-folder="${ALL}"]`);
  await folderShown(pev, ALL);
}

async function openThreads(pev: PevApp, name: string, threads: ThreadSpec[]) {
  const root = realpathSync(testDir(name));
  const written = writeThreads(root, { seed: 71, threads });
  await pev.main('queuePick', root, 'bm1');
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

const rowLocator = (pev: PevApp, row: ListRow) =>
  pev.page.locator(`.list-scroll [role="option"][data-thread="${row.threadId}"]`);

/** Row `row` is the selected one, and its newest message is open in the expanded card. */
async function selected(pev: PevApp, row: ListRow): Promise<void> {
  await expect(rowLocator(pev, row)).toHaveAttribute('aria-selected', 'true');
  await expanded(pev, row.newestRowid);
  await expect(pev.page.locator('.list-scroll [aria-selected="true"]')).toHaveCount(1);
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
  return url;
}

/** Nothing moved: after a moment the reader still shows `rowid`. */
async function stays(pev: PevApp, rowid: number): Promise<void> {
  await pev.page.waitForTimeout(300);
  expect((await reader(pev)).rowid).toBe(rowid);
}

/** Puts the focus in the body frame, so main passes keys on from it. */
const focusFrame = (pev: PevApp) => pev.page.locator('.card.expanded .rp-frame').focus();

/** Hidden windows get no key events from the system: the box's value is set and its input event sent. */
function typeText(page: Page, text: string): Promise<void> {
  return page.evaluate((t) => {
    const box = document.querySelector<HTMLInputElement>('.search-box');
    if (!box) throw new Error('no search box');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(box, t);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
}

const overlay = (page: Page) => page.getByRole('dialog', { name: 'Keyboard shortcuts' });
const settingsMain = (page: Page) => page.locator('main.settings');

async function openSettings(page: Page): Promise<void> {
  await pressButton(page, 'Settings');
  await expect(settingsMain(page)).toBeVisible();
}

async function chooseTheme(page: Page, theme: 'System' | 'Light' | 'Dark'): Promise<void> {
  await openSettings(page);
  await page.getByRole('tab', { name: 'Appearance' }).dispatchEvent('click');
  await page.getByRole('radio', { name: theme }).dispatchEvent('click');
  await expect(page.getByRole('radio', { name: theme })).toBeChecked();
  await pressButton(page, 'Back to mail');
  await expect(settingsMain(page)).toHaveCount(0);
}

const darkInShell = (page: Page) =>
  page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches);

async function checkHidden(pev: PevApp): Promise<void> {
  const windows = await pev.main<Array<{ visible: boolean; focused: boolean }>>('windowState');
  expect(windows.filter((w) => w.visible || w.focused)).toEqual([]);
  expect(await pev.main('windowEvents')).toEqual([]);
  expect(await pev.main('dialogCalls')).toEqual([]);
}

/** A message with HTML and plain text, and its own colours for each scheme. */
const SCHEMES = [
  'Subject: Colours',
  'From: <sender@example.org>',
  'To: <owner@example.com>',
  'Date: Wed, 25 Nov 2026 08:02:11 +0100',
  'Content-Type: multipart/alternative; boundary="alt"',
  '',
  '--alt',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Colours in plain text.',
  '--alt',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<style>@media (prefers-color-scheme: dark) { p { color: rgb(1, 2, 3); } }',
  '@media (prefers-color-scheme: light) { p { color: rgb(4, 5, 6); } }</style>',
  '<p>Colours in HTML.</p>',
  '--alt--',
  '',
].join('\r\n');

/** Shows the colours message alone in the reader pane, as HTML; returns its view's URL. */
async function openSchemes(pev: PevApp): Promise<string> {
  const root = testDir('keys-schemes');
  writeFileSync(join(root, 'schemes.eml'), SCHEMES);
  expect(
    (await pev.main<{ ok: boolean }>('readerSource', root, [[1, { file: 'schemes.eml' }]])).ok,
  ).toBe(true);
  await pev.shell('openInReader', [1]);
  return shownView(pev, 'html');
}

/** Waits until the pane's frame shows the latest view, in `format`; returns its URL. */
async function shownView(pev: PevApp, format: 'html' | 'plain'): Promise<string> {
  await expect
    .poll(async () => {
      const r = await reader(pev);
      const src = await pev.page.locator('.rp-frame').getAttribute('src');
      return !r.pending && r.view?.format === format && src === r.view.url;
    })
    .toBe(true);
  const url = (await reader(pev)).view!.url;
  await pev.bodyFrame(url);
  await expect(pev.page.locator(`.rp-${format}`)).toHaveAttribute('aria-pressed', 'true');
  return url;
}

test('j and k move through the list and the results, opening each row; o and Enter open the focused row', async ({
  pev,
}) => {
  await openThreads(pev, 'keys-list', [
    { messages: 1 },
    { messages: 1 },
    { messages: 1 },
    { messages: 1 },
  ]);
  const all = await rows(pev);
  expect(all).toHaveLength(4);

  // From a selected row, j and k go one row at a time and open it.
  await press(pev.page, `.conv[data-thread="${all[0]!.threadId}"]`);
  await selected(pev, all[0]!);
  await rowLocator(pev, all[0]!).focus();
  await pev.page.keyboard.press('j');
  await selected(pev, all[1]!);
  await expect(rowLocator(pev, all[1]!)).toBeFocused();
  await pev.page.keyboard.press('j');
  await selected(pev, all[2]!);
  await pev.page.keyboard.press('k');
  await selected(pev, all[1]!);
  // With Shift, Control or Option it is another key.
  await pev.page.keyboard.press('Shift+J');
  await pev.page.keyboard.press('Control+j');
  await pev.page.keyboard.press('Alt+j');
  await stays(pev, all[1]!.newestRowid);
  await expect(rowLocator(pev, all[1]!)).toHaveAttribute('aria-selected', 'true');

  // o and Enter open the focused row.
  await rowLocator(pev, all[3]!).focus();
  await pev.page.keyboard.press('o');
  await selected(pev, all[3]!);
  await rowLocator(pev, all[0]!).focus();
  await pev.page.keyboard.press('Enter');
  await selected(pev, all[0]!);

  // The results take the same keys. Each conversation has one message, so a
  // result's row ID is the message its conversation opens with.
  await typeText(pev.page, 'Conversation');
  const results = pev.page.locator('.results [role="option"]');
  await expect(results).toHaveCount(4);
  const opens = async (i: number) => {
    await expect(results.nth(i)).toHaveAttribute('aria-selected', 'true');
    await expanded(pev, Number(await results.nth(i).getAttribute('data-rowid')));
  };
  await results.nth(0).focus();
  await pev.page.keyboard.press('Enter');
  await opens(0);
  await pev.page.keyboard.press('j');
  await opens(1);
  await pev.page.keyboard.press('j');
  await opens(2);
  await pev.page.keyboard.press('k');
  await opens(1);
  await results.nth(3).focus();
  await pev.page.keyboard.press('o');
  await opens(3);
  await checkHidden(pev);
});

test('n and p move the card; o opens a focused collapsed card, Enter on its header opens it once', async ({
  pev,
}) => {
  await openThreads(pev, 'keys-cards', [{ messages: 3 }]);
  const [row] = await rows(pev);
  const ids = await cardIds(pev, row!.newestRowid);
  await press(pev.page, `.conv[data-thread="${row!.threadId}"]`);
  await expanded(pev, ids[2]!);
  await rowLocator(pev, row!).focus();
  await pev.page.keyboard.press('p');
  await expanded(pev, ids[1]!);
  await pev.page.keyboard.press('n');
  await expanded(pev, ids[2]!);

  const installed = count(pev, 'view.installed');
  await pev.page.locator(`.card[data-rowid="${ids[0]}"] .card-h`).focus();
  await pev.page.keyboard.press('o');
  await expanded(pev, ids[0]!);
  // Enter on a card's header is the button's own: one open, not two.
  await pev.page.locator(`.card[data-rowid="${ids[1]}"] .card-h`).focus();
  await pev.page.keyboard.press('Enter');
  await expanded(pev, ids[1]!);
  await pev.page.waitForTimeout(300);
  expect(count(pev, 'view.installed')).toBe(installed + 2);
  // o on the expanded card's header opens nothing again.
  await pev.page.keyboard.press('o');
  await stays(pev, ids[1]!);
  expect(count(pev, 'view.installed')).toBe(installed + 2);
  await checkHidden(pev);
});

test('/ focuses the search box and selects its text, with or without Shift; letters typed there only edit it', async ({
  pev,
}) => {
  await openThreads(pev, 'keys-search', [{ messages: 2 }, { messages: 1 }]);
  const all = await rows(pev);
  const box = pev.page.locator('.search-box');
  await typeText(pev.page, 'Conversation');
  await expect(pev.page.locator('.results [role="option"]')).toHaveCount(2);
  const first = pev.page.locator('.results [role="option"]').first();
  await first.focus();
  await pev.page.keyboard.press('/');
  await expect(box).toBeFocused();
  // The text is selected, and the `/` itself was not typed.
  await expect(box).toHaveValue('Conversation');
  expect(await box.evaluate((b: HTMLInputElement) => [b.selectionStart, b.selectionEnd])).toEqual([
    0,
    'Conversation'.length,
  ]);

  // `/` as Shift+7 (German, Danish, Nordic and Swiss layouts) does the same.
  await first.focus();
  await keydown(pev.page, '.results [role="option"] >> nth=0', {
    key: '/',
    code: 'Digit7',
    shiftKey: true,
  });
  await expect(box).toBeFocused();

  // Every shortcut key typed in the box is text.
  await press(pev.page, `.results [role="option"][data-thread="${all[0]!.threadId}"]`);
  await expanded(pev, all[0]!.newestRowid);
  const installed = count(pev, 'view.installed');
  await box.focus();
  await box.evaluate((b: HTMLInputElement) => b.setSelectionRange(b.value.length, b.value.length));
  await pev.page.keyboard.type(' jknpougia/?');
  await expect(box).toHaveValue('Conversation jknpougia/?');
  await expect(box).toBeFocused();
  await expect(overlay(pev.page)).toHaveCount(0);
  await stays(pev, all[0]!.newestRowid);
  expect(count(pev, 'view.installed')).toBe(installed);
  await expect(pev.page.locator(`[data-folder="${ALL}"]`)).toHaveAttribute('aria-current', 'true');
  await checkHidden(pev);
});

test('g then i or a within a second goes to the Inbox or All Mail; after a second it does nothing', async ({
  pev,
}) => {
  await openThreads(pev, 'keys-go', [
    { messages: 1, labels: () => [INBOX, ALL] },
    { messages: 1, labels: () => [ALL] },
  ]);
  await pev.page.locator('.list-scroll').focus();
  await pev.page.keyboard.press('g');
  await pev.page.keyboard.press('i');
  await folderShown(pev, INBOX);
  await expect(pev.page.locator('.list-scroll [role="option"]')).toHaveCount(1);
  await pev.page.keyboard.press('g');
  await pev.page.keyboard.press('a');
  await folderShown(pev, ALL);
  await expect(pev.page.locator('.list-scroll [role="option"]')).toHaveCount(2);

  // Too late, or after another key: nothing.
  await pev.page.keyboard.press('g');
  await pev.page.waitForTimeout(1100);
  await pev.page.keyboard.press('i');
  await pev.page.keyboard.press('g');
  await pev.page.keyboard.press('x');
  await pev.page.keyboard.press('i');
  await pev.page.waitForTimeout(300);
  await folderShown(pev, ALL);
  await checkHidden(pev);
});

test('u opens the message again in the other view, typed in the shell or in the body frame', async ({
  pev,
}) => {
  await openSchemes(pev);
  // Nothing has the focus: the key goes to the shell's document.
  await pev.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await pev.page.keyboard.press('u');
  await shownView(pev, 'plain');
  await pev.page.keyboard.press('u');
  await shownView(pev, 'html');
  // A held u opens nothing more.
  const installed = count(pev, 'view.installed');
  await keydown(pev.page, 'body', { key: 'u', code: 'KeyU', repeat: true });
  await pev.page.waitForTimeout(300);
  expect(count(pev, 'view.installed')).toBe(installed);

  // From the body frame, main passes u on; a held u it doesn't.
  await pev.page.locator('.rp-frame').focus();
  expect(await pev.main('keyInFocusedFrame', 'u')).toBe('child:mail-body');
  await shownView(pev, 'plain');
  await pev.page.locator('.rp-frame').focus();
  expect(await pev.main('keyInFocusedFrame', 'u', { isAutoRepeat: true })).toBe('child:mail-body');
  await pev.page.waitForTimeout(300);
  expect((await reader(pev)).view?.format).toBe('plain');
  await checkHidden(pev);
});

test('from the body frame main passes on j, k, n, p and Escape, once each; not /, g or a modified key', async ({
  pev,
}) => {
  await openThreads(pev, 'keys-frame', [{ messages: 1 }, { messages: 1 }, { messages: 3 }]);
  const all = await rows(pev);
  const three = all.find((r) => r.count === 3)!;
  const ids = await cardIds(pev, three.newestRowid);
  // Newest first: the three-message conversation is the top row.
  expect(all[0]!.threadId).toBe(three.threadId);
  await press(pev.page, `.conv[data-thread="${three.threadId}"]`);
  await expanded(pev, ids[2]!);

  // Keys the shell's own document sees.
  await pev.page.evaluate(() => {
    const seen = { keys: 0 };
    (window as unknown as { __seen: typeof seen }).__seen = seen;
    window.addEventListener('keydown', () => (seen.keys += 1), true);
  });
  const shellKeys = () =>
    pev.page.evaluate(() => (window as unknown as { __seen: { keys: number } }).__seen.keys);

  await focusFrame(pev);
  expect(await pev.main('keyInFocusedFrame', 'p')).toBe('child:mail-body');
  await expanded(pev, ids[1]!);
  await focusFrame(pev);
  expect(await pev.main('keyInFocusedFrame', 'n')).toBe('child:mail-body');
  await expanded(pev, ids[2]!);

  // Not passed on: `/`, `g` then `i`, and j with a modifier.
  const box = pev.page.locator('.search-box');
  await focusFrame(pev);
  for (const [key, more] of [
    ['/', {}],
    ['g', {}],
    ['i', {}],
    ['j', { shift: true }],
    ['j', { meta: true }],
    ['j', { control: true }],
    ['j', { alt: true }],
  ] as const) {
    expect(await pev.main('keyInFocusedFrame', key, more)).toBe('child:mail-body');
  }
  await stays(pev, ids[2]!);
  await expect(box).not.toBeFocused();
  await folderShown(pev, ALL);
  await expect(rowLocator(pev, three)).toHaveAttribute('aria-selected', 'true');

  // One j moves exactly one row; k comes back.
  await focusFrame(pev);
  expect(await pev.main('keyInFocusedFrame', 'j')).toBe('child:mail-body');
  await selected(pev, all[1]!);
  await focusFrame(pev);
  expect(await pev.main('keyInFocusedFrame', 'k')).toBe('child:mail-body');
  await selected(pev, three);
  expect(await shellKeys()).toBe(0);

  // With the shell focused, main passes nothing on: the shell's key acts once.
  await rowLocator(pev, three).focus();
  expect(await pev.main('keyInFocusedFrame', 'j')).toBe('main');
  await stays(pev, ids[2]!);
  await pev.page.keyboard.press('j');
  await selected(pev, all[1]!);
  await pev.page.waitForTimeout(300);
  await expect(rowLocator(pev, all[1]!)).toHaveAttribute('aria-selected', 'true');

  // Escape from the body frame clears the search.
  await typeText(pev.page, 'Conversation');
  await expect(pev.page.locator('.results [role="option"]')).toHaveCount(3);
  await press(pev.page, `.results [role="option"][data-thread="${three.threadId}"]`);
  await expanded(pev, ids[2]!);
  await focusFrame(pev);
  expect(await pev.main('keyInFocusedFrame', 'Escape')).toBe('child:mail-body');
  await expect(box).toHaveValue('');
  await expect(pev.page.locator('.results')).toHaveCount(0);
  expect(await pev.main('externalCalls')).toEqual([]);
  await checkHidden(pev);
});

test('? shows the shortcuts; Escape or ? closes them, focus goes back, and no other key acts meanwhile', async ({
  pev,
}) => {
  await openThreads(pev, 'keys-overlay', [{ messages: 1 }, { messages: 1 }]);
  const all = await rows(pev);
  await press(pev.page, `.conv[data-thread="${all[0]!.threadId}"]`);
  await selected(pev, all[0]!);
  await rowLocator(pev, all[0]!).focus();

  await pev.page.keyboard.press('?');
  const dialog = overlay(pev.page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(dialog.locator('.shortcuts-grid > span:not(.keys)')).toHaveText([
    'Next / previous conversation',
    'Next / previous message',
    'Search',
    'Open message',
    'Back / close',
    'Toggle plain text',
    'Go to Inbox · All Mail',
    'Shortcuts',
  ]);
  await expect(dialog.locator('.keys')).toHaveText([
    'j k',
    'n p',
    '/',
    'o Enter',
    'Esc',
    'u',
    'g i · g a',
    '?',
  ]);
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
  // Under it, the mail stays, and keys don't reach it.
  await pev.page.keyboard.press('j');
  await pev.page.keyboard.press('/');
  await pev.page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
  await stays(pev, all[0]!.newestRowid);
  await expect(dialog).toBeVisible();

  await pev.page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(rowLocator(pev, all[0]!)).toBeFocused();
  await pev.page.keyboard.press('?');
  await expect(dialog).toBeVisible();
  await pev.page.keyboard.press('?');
  await expect(dialog).toHaveCount(0);
  await expect(rowLocator(pev, all[0]!)).toBeFocused();
  // Its close button too.
  await pev.page.keyboard.press('?');
  await dialog.getByRole('button', { name: 'Close' }).dispatchEvent('click');
  await expect(dialog).toHaveCount(0);
  await checkHidden(pev);
});

test('Escape closes the overlay, then Settings, then the report, then clears the search; never a confirmation and what is under it', async ({
  pev,
}) => {
  const root = realpathSync(testDir('keys-escape'));
  const written = writeThreads(root, { seed: 71, threads: [{ messages: 1 }, { messages: 1 }] });
  // A file the scan refuses, so the list header opens the report.
  const eml = readdirSync(written.run).find((n) => n.endsWith('.eml'))!;
  symlinkSync(join(written.run, eml), join(written.run, 'zz-link.metadata.json'));
  await pev.main('queuePick', root, 'bm1');
  await pev.shell('chooseFolder', []);
  await phase1Done(pev, written.pairs);

  await press(pev.page, '.list-head .attention');
  await expect(pev.page.locator('.ix-card')).toBeVisible();
  await typeText(pev.page, 'Conversation');
  await openSettings(pev.page);
  await keydown(pev.page, 'main.settings', { key: '?', shiftKey: true });
  await expect(overlay(pev.page)).toBeVisible();

  await pev.page.keyboard.press('Escape');
  await expect(overlay(pev.page)).toHaveCount(0);
  await expect(settingsMain(pev.page)).toBeVisible();

  // A confirmation over Settings keeps its own Escape: Settings stays.
  await pressButton(pev.page, 'Reset app…');
  const confirm = pev.page.getByRole('dialog', { name: 'Reset app?' });
  await expect(confirm).toBeVisible();
  await pev.page.keyboard.press('?');
  await expect(overlay(pev.page)).toHaveCount(0);
  await pev.page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(settingsMain(pev.page)).toBeVisible();

  await keydown(pev.page, 'main.settings', { key: 'Escape' });
  await expect(settingsMain(pev.page)).toHaveCount(0);
  await expect(pev.page.locator('.ix-card')).toBeVisible();
  await keydown(pev.page, '.ix-card', { key: 'Escape' });
  await expect(pev.page.locator('.ix-card')).toHaveCount(0);
  await expect(pev.page.locator('.search-box')).toHaveValue('Conversation');
  await keydown(pev.page, 'main.content', { key: 'Escape' });
  await expect(pev.page.locator('.search-box')).toHaveValue('');
  await expect(pev.page.locator('.results')).toHaveCount(0);
  await checkHidden(pev);
});

test('the theme from Settings applies to the shell at once and after a restart', async () => {
  const first = await launch('keys-theme', { appColorScheme: true });
  try {
    expect(await first.main('themeSource')).toBe('system');
    await chooseTheme(first.page, 'Dark');
    await expect.poll(() => first.main('themeSource')).toBe('dark');
    await expect.poll(() => darkInShell(first.page)).toBe(true);
    await chooseTheme(first.page, 'Light');
    await expect.poll(() => first.main('themeSource')).toBe('light');
    await expect.poll(() => darkInShell(first.page)).toBe(false);
    await chooseTheme(first.page, 'Dark');
    await expect.poll(() => darkInShell(first.page)).toBe(true);
  } finally {
    await first.close();
  }
  const second = await launch('keys-theme', { userData: first.userData, appColorScheme: true });
  try {
    expect(await second.main('themeSource')).toBe('dark');
    expect(await darkInShell(second.page)).toBe(true);
    await chooseTheme(second.page, 'System');
    await expect.poll(() => second.main('themeSource')).toBe('system');
    await checkHidden(second);
  } finally {
    await second.close();
  }
});

test("a message's own dark-mode rules follow the theme setting in its frame", async () => {
  const pev = await launch('keys-schemes-theme', { appColorScheme: true });
  try {
    const color = async () => {
      const url = await shownView(pev, 'html');
      const frame = await pev.bodyFrame(url);
      return frame.locator('p').evaluate((p) => getComputedStyle(p).color);
    };
    await openSchemes(pev);
    await chooseTheme(pev.page, 'Dark');
    await expect.poll(color).toBe('rgb(1, 2, 3)');
    await chooseTheme(pev.page, 'Light');
    await expect.poll(color).toBe('rgb(4, 5, 6)');
    await chooseTheme(pev.page, 'Dark');
    await expect.poll(color).toBe('rgb(1, 2, 3)');
    await checkHidden(pev);
  } finally {
    await pev.close();
  }
});
