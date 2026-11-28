// SPDX-License-Identifier: AGPL-3.0-or-later
// The search's chips in the shell: each finds what its typed operator finds,
// a label or folder chip matches by ID whatever its name holds, chips with no
// text search by date, removing one leaves the typed text, and Esc clears
// the text and the chips.

import { realpathSync } from 'node:fs';
import type { Chip } from '../../src/shared/search-chips';
import { testDir } from '../paths';
import { expect, test, type PevApp } from './app';
import {
  LABELS,
  addChip,
  chipExport,
  chipTexts,
  keyInBox,
  openExport,
  removeChip,
  searchState,
  settled,
  typeText,
} from './search-ui';

/** The shown conversations, as their messages' IDs would sort: by conversation ID. */
const shown = async (pev: PevApp) => [...(await searchState(pev)).threadIds].sort((a, b) => a - b);

async function checkHidden(pev: PevApp): Promise<void> {
  const windows = await pev.main<Array<{ visible: boolean; focused: boolean }>>('windowState');
  expect(windows.filter((w) => w.visible || w.focused)).toEqual([]);
  expect(await pev.main('windowEvents')).toEqual([]);
  expect(await pev.main('dialogCalls')).toEqual([]);
}

test('each chip finds what its typed operator finds, and shows as text', async ({ pev }) => {
  const written = chipExport(realpathSync(testDir('chips-each')), 81);
  await openExport(pev, written);
  const same: Array<[string, Chip, string]> = [
    ['from:alice', { k: 'from', v: 'alice' }, 'From: alice'],
    ['from:"Alice Moreau"', { k: 'from', v: 'Alice Moreau' }, 'From: Alice Moreau'],
    ['from:alice@example.com', { k: 'from', v: 'alice@example.com' }, 'From: alice@example.com'],
    ['has:attachment', { k: 'attachment' }, 'Has attachment'],
    ['after:2024-01-01', { k: 'after', d: '2024-01-01' }, 'After 1 Jan 2024'],
    ['label:Work', { k: 'label', id: LABELS.labelWork }, 'Work'],
    ['folder:Work', { k: 'folder', id: LABELS.folderWork }, 'Work'],
    ['folder:Inbox', { k: 'folder', id: '0' }, 'Inbox'],
    ['folder:"x y"', { k: 'folder', id: LABELS.folderXY }, 'x y'],
    ['is:unread', { k: 'unread' }, 'Unread'],
  ];
  for (const [typed, chip, text] of same) {
    await typeText(pev.page, typed);
    await settled(pev, typed);
    const want = await shown(pev);
    expect(want.length, typed).toBeGreaterThan(0);
    expect(want.length, typed).toBeLessThan(3);

    // The chip row shows with the results: added to other text, then alone.
    await keyInBox(pev.page, 'Escape');
    await typeText(pev.page, 'budget');
    await settled(pev, 'budget', 0);
    await addChip(pev.page, chip);
    await settled(pev, 'budget', 1);
    await typeText(pev.page, '');
    await settled(pev, '', 1);
    expect(await shown(pev), typed).toEqual(want);
    expect(await chipTexts(pev.page), typed).toEqual([text]);

    // Esc clears the text and the chips, and the folder's list is back.
    await keyInBox(pev.page, 'Escape');
    await expect(pev.page.locator('.results')).toHaveCount(0);
    expect(await searchState(pev)).toMatchObject({ text: '', chips: [], active: false });
  }
  // A From value with a space matches it whole; without, by prefix.
  await typeText(pev.page, 'from:alice');
  expect((await settled(pev, 'from:alice')).total).toBe(2);
  await typeText(pev.page, 'from:"Alice Moreau"');
  expect((await settled(pev, 'from:"Alice Moreau"')).total).toBe(1);
  await checkHidden(pev);
});

test('a label or folder chip matches by ID whatever its name holds, and removing one leaves the text', async ({
  pev,
}) => {
  const written = chipExport(realpathSync(testDir('chips-hostile')), 82);
  await openExport(pev, written);
  await typeText(pev.page, 'budget');
  const both = await settled(pev, 'budget', 0);
  expect(both.total).toBe(2);
  const all = await shown(pev);

  // `a "b": -c` is a name, never operators: it matches only its message.
  await addChip(pev.page, { k: 'label', id: LABELS.labelHostile });
  const hostile = await settled(pev, 'budget', 1);
  expect(hostile.total).toBe(1);
  const bob = await shown(pev);
  expect(await chipTexts(pev.page)).toEqual(['a "b": -c']);
  await expect(pev.page.locator('.search-chips .search-chip .chip-name').first()).toHaveAttribute(
    'dir',
    'auto',
  );
  // So is the folder `x y`.
  await addChip(pev.page, { k: 'folder', id: LABELS.folderXY });
  expect((await settled(pev, 'budget', 2)).total).toBe(1);
  expect(await shown(pev)).toEqual(bob);
  await addChip(pev.page, { k: 'unread' });
  expect((await settled(pev, 'budget', 3)).total).toBe(0);
  expect(await chipTexts(pev.page)).toEqual(['a "b": -c', 'x y', 'Unread']);

  // Each remove takes exactly its own chip; the typed text stays as it is.
  await removeChip(pev.page, 2);
  expect((await settled(pev, 'budget', 2)).total).toBe(1);
  expect(await chipTexts(pev.page)).toEqual(['a "b": -c', 'x y']);
  await removeChip(pev.page, 0);
  expect((await settled(pev, 'budget', 1)).total).toBe(1);
  expect(await chipTexts(pev.page)).toEqual(['x y']);
  await removeChip(pev.page, 0);
  await settled(pev, 'budget', 0);
  expect(await shown(pev)).toEqual(all);
  await expect(pev.page.locator('.search-box')).toHaveValue('budget');

  // The label named "Work" and the folder named "Work" are each their own.
  await addChip(pev.page, { k: 'label', id: LABELS.labelWork });
  expect((await settled(pev, 'budget', 1)).total).toBe(1);
  await removeChip(pev.page, 0);
  await settled(pev, 'budget', 0);
  await addChip(pev.page, { k: 'folder', id: LABELS.folderWork });
  expect((await settled(pev, 'budget', 1)).total).toBe(0);
  await checkHidden(pev);
});

test('chips with no text search by date; emptying the box keeps them, Esc clears both', async ({
  pev,
}) => {
  const written = chipExport(realpathSync(testDir('chips-only')), 83);
  await openExport(pev, written);
  await typeText(pev.page, 'lunch');
  await settled(pev, 'lunch', 0);
  await addChip(pev.page, { k: 'after', d: '2023-12-31' });
  await settled(pev, 'lunch', 1);
  // The box emptied: the chips stay, and the search goes on with them alone, by date.
  await typeText(pev.page, '');
  const alone = await settled(pev, '', 1);
  expect(alone.total).toBe(3);
  await expect(pev.page.locator('.results select.sort')).toHaveValue('date');
  await expect(pev.page.locator('.list:not(.results)')).toHaveCount(0);
  // A From value with no word adds nothing.
  await pev.page.locator('.search-chips .chip-add', { hasText: 'From:' }).dispatchEvent('click');
  await pev.page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>(
      '.search-chips .chip-field[aria-label="From"]',
    )!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '!!!');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await pev.page.waitForTimeout(300);
  expect((await searchState(pev)).chips).toEqual([{ k: 'after', d: '2023-12-31' }]);
  // Removing the last chip with the box empty shows the folder's list again.
  await removeChip(pev.page, 0);
  await expect(pev.page.locator('.results')).toHaveCount(0);
  expect(await searchState(pev)).toMatchObject({ text: '', chips: [], active: false });

  // Esc clears both.
  await typeText(pev.page, 'budget');
  await settled(pev, 'budget', 0);
  await addChip(pev.page, { k: 'unread' });
  await settled(pev, 'budget', 1);
  await keyInBox(pev.page, 'Escape');
  await expect(pev.page.locator('.results')).toHaveCount(0);
  expect(await searchState(pev)).toMatchObject({ text: '', chips: [], active: false });
  await checkHidden(pev);
});
