// SPDX-License-Identifier: AGPL-3.0-or-later
// The search box, its chips, the recent-searches menu and Settings' controls
// for them, driven as the shell's own events would. Hidden windows get no
// input from the system, so values are set and events sent directly.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Page } from '@playwright/test';
import type { DoneResult, RecentSearchesResult } from '../../src/shared/api';
import type { IndexProgress, IndexTotals } from '../../src/shared/index-types';
import type { Chip } from '../../src/shared/search-chips';
import type { Stamp } from '../../src/shared/sources';
import { writeExport, type WrittenExport } from '../exports';
import { writeMessage } from '../thread-export';
import { expect, type PevApp } from './app';

type Answer<T> = { answer: T; progress: IndexProgress } | null;
export const ask = <T>(pev: PevApp, query: unknown) => pev.main<Answer<T>>('indexQuery', query);

export interface SearchState {
  text: string;
  chips: Chip[];
  resultsFor: string | null;
  active: boolean;
  searching: boolean;
  failed: boolean;
  total: number | null;
  threadIds: number[];
}

export const searchState = (pev: PevApp) => pev.shell<SearchState>('search');

export async function phase1Done(pev: PevApp, total: number): Promise<void> {
  await expect
    .poll(async () => (await ask<IndexTotals>(pev, { op: 'totals' }))?.progress, {
      timeout: 20_000,
    })
    .toMatchObject({ phase: 'done', loaded: total, total });
}

/**
 * Waits until the mail follows main's open export and generation. The shell
 * takes a new generation first and the mail follows it a moment later,
 * clearing the search box: text typed before that would be lost.
 */
export async function mailboxFollows(pev: PevApp): Promise<void> {
  const stamp = await pev.main<Stamp | null>('sourceStamp');
  if (!stamp) throw new Error('no open export');
  await expect
    .poll(() => pev.shell<string | null>('mailboxKey'))
    .toBe(`${stamp.sourceKey}:${stamp.generation}`);
}

export async function openExport(
  pev: PevApp,
  written: WrittenExport,
  bookmark = 'bm1',
): Promise<Stamp> {
  await pev.main('queuePick', written.root, bookmark);
  await pev.shell('chooseFolder', []);
  await phase1Done(pev, written.pairs);
  await mailboxFollows(pev);
  return pev.main<Stamp>('sourceStamp');
}

/** Sets the search box's text, as its input event does. */
export function typeText(page: Page, text: string): Promise<void> {
  return page.evaluate((t) => {
    const box = document.querySelector<HTMLInputElement>('.search-box');
    if (!box) throw new Error('no search box');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(box, t);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
}

/** Sends a key to the search box. */
export const keyInBox = (page: Page, key: 'Enter' | 'Escape' | 'ArrowDown' | 'ArrowUp') =>
  page.locator('.search-box').dispatchEvent('keydown', { key, bubbles: true });

/** Waits until the search for `text` (and the chips, if given) has its answer. */
export async function settled(pev: PevApp, text: string, chips?: number): Promise<SearchState> {
  await expect
    .poll(async () => {
      const s = await searchState(pev);
      return (
        s.resultsFor === text &&
        s.active &&
        !s.searching &&
        (chips === undefined || s.chips.length === chips)
      );
    })
    .toBe(true);
  return searchState(pev);
}

/** Sets an input's value as its input event does, then sends it a key. */
async function fill(page: Page, selector: string, value: string, key?: string): Promise<void> {
  await page.evaluate(
    ([sel, v, k]) => {
      const input = document.querySelector<HTMLInputElement>(sel);
      if (!input) throw new Error(`no ${sel}`);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (k) input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    },
    [selector, value, key ?? ''] as const,
  );
}

const addButton = (page: Page, text: string) =>
  page.locator('.search-chips .chip-add', { hasText: text });

/**
 * Adds a chip through the chip row, as the user does: From and After through
 * their fields and Enter, a label or folder from its list, a toggle by its
 * button. The row shows while a search is active.
 */
export async function addChip(page: Page, chip: Chip): Promise<void> {
  switch (chip.k) {
    case 'from':
      await addButton(page, 'From:').dispatchEvent('click');
      await fill(page, '.search-chips .chip-field[aria-label="From"]', chip.v, 'Enter');
      return;
    case 'after':
      await addButton(page, 'After').dispatchEvent('click');
      await fill(page, '.search-chips .chip-field[aria-label="After"]', chip.d, 'Enter');
      return;
    case 'attachment':
      await addButton(page, 'Has attachment').dispatchEvent('click');
      return;
    case 'unread':
      await addButton(page, 'Unread').dispatchEvent('click');
      return;
    case 'label':
    case 'folder': {
      const list = chip.k === 'label' ? 'Labels' : 'Folders';
      await addButton(page, chip.k === 'label' ? 'Label' : 'Folder').dispatchEvent('click');
      await page
        .locator(`.chip-choices[aria-label="${list}"] .chip-choice[data-id="${chip.id}"]`)
        .dispatchEvent('click');
    }
  }
}

/** The chips the row shows, as text. */
export const chipTexts = (page: Page) =>
  page.locator('.search-chips .search-chip .chip-name').allTextContents();

/** Removes the chip shown at `index`, with its remove button. */
export const removeChip = (page: Page, index: number) =>
  page
    .locator('.search-chips .search-chip')
    .nth(index)
    .getByRole('button', { name: 'Remove filter' })
    .dispatchEvent('click');

/**
 * Commits the box's search with Enter and waits until main has answered the
 * commit: the box's search is then the shown one.
 */
export async function enter(pev: PevApp, text: string, chips?: number): Promise<SearchState> {
  await keyInBox(pev.page, 'Enter');
  return settled(pev, text, chips);
}

/** The recent searches main lists for the shell's current generation. */
export const recentList = (page: Page) =>
  page.evaluate(async () => {
    const api = (window as unknown as { __pevTest: { state(): { generation: number | null } } })
      .__pevTest;
    const pev = (
      window as unknown as { pev: { recentSearches(g: number): Promise<RecentSearchesResult> } }
    ).pev;
    return pev.recentSearches(api.state().generation ?? 0);
  });

/** The recent searches' texts, newest first; null if main refused. */
export async function recentTexts(page: Page): Promise<string[] | null> {
  const result = await recentList(page);
  return result.ok ? result.entries.map((e) => e.text) : null;
}

/** Focuses the empty box, which opens the menu, and returns its entries' texts once shown. */
export async function menuEntries(page: Page): Promise<string[]> {
  await page.locator('.search-box').blur();
  await page.locator('.search-box').focus();
  // The menu is read from main; it shows once that answer is in.
  await page.waitForTimeout(300);
  return page.locator('.recent-menu .recent-entry').allTextContents();
}

/** Opens Settings, then its Index tab. */
export async function openIndexSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).dispatchEvent('click');
  await expect(page.locator('main.settings')).toBeVisible();
  await page.getByRole('tab', { name: 'Index' }).dispatchEvent('click');
  await expect(page.getByRole('tab', { name: 'Index' })).toHaveAttribute('aria-selected', 'true');
}

/** Back to the mail from Settings. */
export async function backToMail(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Back to mail' }).dispatchEvent('click');
  await expect(page.locator('.mail-screen')).toBeVisible();
}

export const keepSwitch = (page: Page) =>
  page.getByRole('switch', { name: 'Keep recent searches' });

/** Turns "Keep recent searches" on or off in Settings, and waits until it shows that. */
export async function setKeep(page: Page, on: boolean): Promise<void> {
  const box = keepSwitch(page);
  await expect(box).toBeChecked({ checked: !on });
  await box.dispatchEvent('click');
  await expect(box).toBeChecked({ checked: on });
}

export const clearButton = (page: Page) =>
  page.getByRole('button', { name: 'Clear recent searches', exact: true });

/** Calls a recent-search action in main directly, as a stale Settings screen would. */
export const invoke = (page: Page, channel: string, args: unknown) =>
  page.evaluate(
    ([c, a]) =>
      (
        window as unknown as {
          __pevTestIpc: { invoke(c: string, a: unknown): Promise<DoneResult> };
        }
      ).__pevTestIpc.invoke(c, a),
    [channel, args] as const,
  );

/** The index's recent-search rows, read from the file while no app has it open. */
export function indexRows(dbPath: string): Array<{ q: string; at: number }> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare('SELECT q, at FROM recent_searches ORDER BY at DESC, id DESC')
      .all()
      .map((r) => ({ q: String(r.q), at: Number(r.at) }));
  } finally {
    db.close();
  }
}

/** Adds rows to the index's recent searches while no app has it open. */
export function addIndexRows(dbPath: string, rows: Array<{ q: string; at: number }>): void {
  const db = new DatabaseSync(dbPath);
  try {
    const insert = db.prepare('INSERT INTO recent_searches(q, at) VALUES (?, ?)');
    for (const r of rows) insert.run(r.q, r.at);
  } finally {
    db.close();
  }
}

/** Local midnight of a YYYY-MM-DD day, in seconds, as core's day start. */
export function localDay(d: string): number {
  const [y, m, day] = d.split('-').map(Number);
  return Math.floor(new Date(y!, m! - 1, day!).getTime() / 1000);
}

export const LABELS = {
  folderXY: 'F-xy',
  folderWork: 'F-work',
  labelWork: 'L-work',
  labelHostile: 'L-hostile',
} as const;

/**
 * An export for the chips: three messages with their own sender, day,
 * folders, labels, attachment count and unread flag. A label is named
 * `a "b": -c` and a user folder `x y`; a label and a folder share the name
 * "Work".
 */
export function chipExport(root: string, seed: number, runName?: string): WrittenExport {
  const base = writeExport(root, { seed, messages: 0, ...(runName ? { runName } : {}) });
  writeFileSync(
    join(base.run, 'labels.json'),
    JSON.stringify({
      Version: 1,
      Payload: [
        { ID: LABELS.folderXY, Name: 'x y', Path: 'x y', Type: 3 },
        { ID: LABELS.folderWork, Name: 'Work', Path: 'Work', Type: 3 },
        { ID: LABELS.labelWork, Name: 'Work', Path: 'Work', Type: 1, Color: '#F78400' },
        {
          ID: LABELS.labelHostile,
          Name: 'a "b": -c',
          Path: 'a "b": -c',
          Type: 1,
          Color: '#1DA583',
        },
      ],
    }),
  );
  const put = (
    id: string,
    time: number,
    subject: string,
    from: { name: string; address: string },
    labels: string[],
    patch: Record<string, unknown> = {},
  ) => {
    writeMessage(base.run, id, {
      time,
      subject,
      from,
      labels,
      messageId: `${id}@example.com`,
      references: [],
      body: `Body of ${id}.`,
    });
    const file = join(base.run, `${id}.metadata.json`);
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { Payload: Record<string, unknown> };
    Object.assign(doc.Payload, patch);
    writeFileSync(file, JSON.stringify(doc));
  };
  put(
    'alice',
    localDay('2024-01-10') + 3600,
    'budget plan',
    { name: 'Alice Moreau', address: 'alice@example.com' },
    ['0', '5', LABELS.labelWork],
    { Unread: 1 },
  );
  put(
    'bob',
    localDay('2024-01-01'),
    'budget review',
    { name: 'Bob', address: 'bob@corp.test' },
    ['5', LABELS.folderXY, LABELS.labelHostile],
    { NumAttachments: 1 },
  );
  put(
    'carol',
    localDay('2023-12-31') + 86399,
    'lunch',
    { name: 'Carol Alicebrook', address: 'carol@other.test' },
    ['5', LABELS.folderWork],
  );
  return { ...base, pairs: 3 };
}
