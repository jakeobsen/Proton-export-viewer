// SPDX-License-Identifier: AGPL-3.0-or-later
// Recent searches end to end: recorded on Enter or when a result opens, never
// per keystroke; the newest 20, a repeat at the top; the menu; "Keep recent
// searches" and "Clear recent searches" with the writer held in core; the
// wipe owed after Off, paid at the next activation after a core exit, a
// switch or a relaunch; the gate while one is owed; Rebuild; two exports; an
// export that is unavailable; stale requests; Forget; and an older registry.

import { readFileSync, realpathSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { IPC } from '../../src/shared/api';
import { searchKey } from '../../src/shared/search-chips';
import type { SourcesView, Stamp } from '../../src/shared/sources';
import { testDir } from '../paths';
import { expect, launch, test, type PevApp } from './app';
import {
  LABELS,
  addChip,
  addIndexRows,
  backToMail,
  chipExport,
  clearButton,
  indexRows,
  invoke,
  keepSwitch,
  keyInBox,
  openExport,
  openIndexSettings,
  phase1Done,
  recentList,
  recentTexts,
  searchState,
  setKeep,
  settled,
  typeText,
} from './search-ui';

/** Runs `text` and commits it with Enter once it is the shown search. */
async function commit(pev: PevApp, text: string): Promise<void> {
  await typeText(pev.page, text);
  await settled(pev, text);
  await keyInBox(pev.page, 'Enter');
}

const recorded = (pev: PevApp, texts: string[]) =>
  expect.poll(() => recentTexts(pev.page), { timeout: 10_000 }).toEqual(texts);

/** The texts of the index's rows, newest first, read while no app has the index open. */
const rowTexts = (dbPath: string) =>
  indexRows(dbPath).map((r) => (JSON.parse(r.q) as { text: string }).text);

async function dbPathOf(pev: PevApp): Promise<string> {
  const stamp = await pev.main<Stamp>('sourceStamp');
  return join(await pev.main<string>('indexDir'), `${stamp.sourceKey}.sqlite`);
}

function sourceRecord(file: string, sourceKey: string): Record<string, unknown> | undefined {
  const registry = JSON.parse(readFileSync(file, 'utf8')) as {
    sources: Array<Record<string, unknown> & { sourceKey: string }>;
  };
  return registry.sources.find((s) => s.sourceKey === sourceKey);
}

/** Waits until the source owes no wipe: one has committed and its clear is saved. */
const owesNothing = (file: string, sourceKey: string) =>
  expect
    .poll(() => sourceRecord(file, sourceKey)?.recentWipePending ?? false, { timeout: 10_000 })
    .toBe(false);

const logCount = (pev: PevApp, code: string, match: Record<string, unknown> = {}) =>
  pev
    .logs()
    .filter(
      (l) =>
        l.code === code &&
        Object.entries(match).every(([k, v]) => (k === 'proc' ? l.proc === v : l.data[k] === v)),
    ).length;

/** Waits for core's answer to the next unplanned exit: a restart under a new generation. */
async function coreExits(pev: PevApp, pairs: number): Promise<Stamp> {
  const before = await pev.main<Stamp>('sourceStamp');
  const restarts = logCount(pev, 'core.restart');
  await pev.main('core', 'exit');
  await expect.poll(() => logCount(pev, 'core.restart')).toBe(restarts + 1);
  await expect
    .poll(async () => (await pev.main<Stamp>('sourceStamp')).generation)
    .toBeGreaterThan(before.generation);
  await phase1Done(pev, pairs);
  return pev.main<Stamp>('sourceStamp');
}

async function checkHidden(pev: PevApp): Promise<void> {
  const windows = await pev.main<Array<{ visible: boolean; focused: boolean }>>('windowState');
  expect(windows.filter((w) => w.visible || w.focused)).toEqual([]);
  expect(await pev.main('windowEvents')).toEqual([]);
  expect(await pev.main('dialogCalls')).toEqual([]);
}

/**
 * Focuses the empty box, which opens the recent-searches menu; ArrowDown
 * opens it too, and is sent only if focusing didn't.
 */
async function openMenu(pev: PevApp): Promise<void> {
  await pev.page.locator('.search-box').focus();
  await pev.page.waitForTimeout(200);
  if ((await pev.page.locator('.recent-menu').count()) === 0) {
    await keyInBox(pev.page, 'ArrowDown');
  }
}

test('a search is recorded on Enter or when a result opens, never per keystroke; 20 kept, newest first', async ({
  pev,
}) => {
  const written = chipExport(realpathSync(testDir('recent-basic')), 90);
  await openExport(pev, written);

  // Typed letter by letter, each search answered: nothing is recorded.
  for (const text of ['b', 'bu', 'bud', 'budg', 'budge', 'budget']) {
    await typeText(pev.page, text);
    await settled(pev, text);
  }
  expect(await recentTexts(pev.page)).toEqual([]);
  expect(await pev.main<number>('recentReceived')).toBe(0);

  // Enter within the typing pause runs the box's text at once and records it whole.
  await typeText(pev.page, 'invoic');
  await settled(pev, 'invoic');
  await pev.page.evaluate(() => {
    const box = document.querySelector<HTMLInputElement>('.search-box')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(box, 'invoice');
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await recorded(pev, ['invoice']);

  // Opening a result records the search it belongs to.
  await typeText(pev.page, 'budget');
  await settled(pev, 'budget');
  await pev.page.locator('.results .conv[data-thread]').first().dispatchEvent('click');
  await recorded(pev, ['budget', 'invoice']);
  expect(await pev.main<number>('recentReceived')).toBe(2);

  // 21 more: the newest 20 are kept, newest first; a repeat moves to the top.
  for (let i = 1; i <= 21; i += 1) await commit(pev, `w${i}`);
  const newest = Array.from({ length: 20 }, (_, i) => `w${21 - i}`);
  await recorded(pev, newest);
  await commit(pev, 'w5');
  await recorded(pev, ['w5', ...newest.filter((t) => t !== 'w5')]);

  // A search with chips is one entry: its text and its chips' names, as text.
  await typeText(pev.page, 'budget');
  await settled(pev, 'budget', 0);
  await addChip(pev.page, { k: 'label', id: LABELS.labelHostile });
  await settled(pev, 'budget', 1);
  await keyInBox(pev.page, 'Enter');
  await expect
    .poll(async () => {
      const result = await recentList(pev.page);
      return result.ok ? result.entries[0] : null;
    })
    .toEqual({ text: 'budget', chips: [{ k: 'label', id: LABELS.labelHostile }] });

  // The menu: shown from the empty box with no chips; picking runs the search, unrecorded.
  await keyInBox(pev.page, 'Escape');
  const received = await pev.main<number>('recentReceived');
  await openMenu(pev);
  const entries = pev.page.locator('.recent-menu .recent-entry');
  await expect(entries).toHaveCount(20);
  await expect(entries.first().locator('.recent-part')).toHaveText(['budget', 'a "b": -c']);
  await expect(entries.nth(1)).toHaveText('w5');
  await entries.first().dispatchEvent('click');
  const picked = await settled(pev, 'budget', 1);
  expect(picked.total).toBe(1);
  await expect(pev.page.locator('.recent-menu')).toHaveCount(0);
  // Arrows and Enter pick too.
  await keyInBox(pev.page, 'Escape');
  await openMenu(pev);
  await expect(entries).toHaveCount(20);
  await keyInBox(pev.page, 'ArrowDown');
  await keyInBox(pev.page, 'ArrowDown');
  await expect(entries.nth(1)).toHaveAttribute('aria-selected', 'true');
  await keyInBox(pev.page, 'Enter');
  await settled(pev, 'w5', 0);
  expect(await pev.main<number>('recentReceived')).toBe(received);
  // Not with text in the box.
  await openMenu(pev);
  await pev.page.waitForTimeout(300);
  await expect(pev.page.locator('.recent-menu')).toHaveCount(0);
  await checkHidden(pev);
});

test('held in core: a recording then Off, a recording made while off, and a recording then Clear leave no entry, also after a relaunch', async () => {
  const written = chipExport(realpathSync(testDir('recent-held')), 91);
  const first = await launch('recent-held');
  let dbPath: string;
  let sourceKey: string;
  let file: string;
  try {
    sourceKey = (await openExport(first, written)).sourceKey;
    dbPath = await dbPathOf(first);
    file = await first.main<string>('registryFile');
    await commit(first, 'alpha');
    await recorded(first, ['alpha']);

    // Received while on, held in core; then Off; then released: no entry.
    await first.main('holdRecent');
    await commit(first, 'beta');
    await expect.poll(() => first.main<number>('heldRecent')).toBe(1);
    await openIndexSettings(first.page);
    await setKeep(first.page, false);
    expect(sourceRecord(file, sourceKey)).toMatchObject({
      keepRecentSearches: false,
      recentWipePending: true,
    });
    expect(await first.main<number>('releaseRecent')).toBe(1);
    await owesNothing(file, sourceKey);
    await expect.poll(() => first.hasLog('recent.cleared', { proc: 'core', count: 2 })).toBe(true);
    await backToMail(first.page);

    // Committed while off, the writer held; then On; then released: dropped
    // at once in main, so core never gets it.
    const received = await first.main<number>('recentReceived');
    await first.main('holdRecent');
    await commit(first, 'gamma');
    await expect.poll(() => logCount(first, 'recent.dropped', { reason: 'off' })).toBe(1);
    await openIndexSettings(first.page);
    await setKeep(first.page, true);
    expect(await first.main<number>('releaseRecent')).toBe(0);
    await backToMail(first.page);
    expect(await first.main<number>('recentReceived')).toBe(received);
    expect(await recentTexts(first.page)).toEqual([]);

    // Received, held; then Clear; then released: no entry.
    await first.main('holdRecent');
    await commit(first, 'delta');
    await expect.poll(() => first.main<number>('heldRecent')).toBe(1);
    await openIndexSettings(first.page);
    await clearButton(first.page).dispatchEvent('click');
    expect(await first.main<number>('releaseRecent')).toBe(1);
    await expect.poll(() => logCount(first, 'recent.cleared', { proc: 'core', count: 1 })).toBe(1);
    await expect(first.page.locator('.settings-notice')).toHaveCount(0);
    await backToMail(first.page);
    expect(await recentTexts(first.page)).toEqual([]);

    // Off again, for the relaunch.
    await commit(first, 'epsilon');
    await recorded(first, ['epsilon']);
    await openIndexSettings(first.page);
    await setKeep(first.page, false);
    await owesNothing(file, sourceKey);
    await checkHidden(first);
  } finally {
    await first.close();
  }
  expect(rowTexts(dbPath)).toEqual([]);

  const second = await launch('recent-held-2', { userData: first.userData });
  try {
    await phase1Done(second, written.pairs);
    await openIndexSettings(second.page);
    await expect(keepSwitch(second.page)).not.toBeChecked();
    await backToMail(second.page);
    // The relaunch shares the first launch's logs: count from here.
    const offDrops = logCount(second, 'recent.dropped', { reason: 'off' });
    await commit(second, 'zeta');
    await expect
      .poll(() => logCount(second, 'recent.dropped', { reason: 'off' }))
      .toBe(offDrops + 1);
  } finally {
    await second.close();
  }
  expect(rowTexts(dbPath)).toEqual([]);
  expect(sourceRecord(file, sourceKey)).toMatchObject({ keepRecentSearches: false });
});

test('Off then On with the wipe still held: the menu is empty at once and after release, and a later search is recorded', async ({
  pev,
}) => {
  const written = chipExport(realpathSync(testDir('recent-gate-held')), 92);
  const { sourceKey } = await openExport(pev, written);
  const file = await pev.main<string>('registryFile');
  await commit(pev, 'alpha');
  await recorded(pev, ['alpha']);

  await pev.main('holdRecent');
  await openIndexSettings(pev.page);
  await setKeep(pev.page, false);
  await expect.poll(() => pev.main<number>('heldRecent')).toBe(1);
  await setKeep(pev.page, true);
  expect(sourceRecord(file, sourceKey)).toMatchObject({
    keepRecentSearches: true,
    recentWipePending: true,
  });
  await backToMail(pev.page);
  // The gate answers while the wipe is held: no entry, without waiting for it.
  expect(await recentTexts(pev.page)).toEqual([]);
  await openMenu(pev);
  await pev.page.waitForTimeout(300);
  await expect(pev.page.locator('.recent-menu')).toHaveCount(0);
  await pev.page.locator('.search-box').blur();

  expect(await pev.main<number>('releaseRecent')).toBe(1);
  await owesNothing(file, sourceKey);
  expect(await recentTexts(pev.page)).toEqual([]);
  await commit(pev, 'omega');
  await recorded(pev, ['omega']);
  await checkHidden(pev);
});

test('a real core exit: an Off held in core, Off then On held, and a Clear held each end right after the restart', async ({
  pev,
}) => {
  const written = chipExport(realpathSync(testDir('recent-core-exit')), 93);
  const { sourceKey } = await openExport(pev, written);
  const file = await pev.main<string>('registryFile');

  // Off with its wipe held, then core exits: the next activation's wipe deletes the entry.
  await commit(pev, 'alpha');
  await recorded(pev, ['alpha']);
  await pev.main('holdRecent');
  await openIndexSettings(pev.page);
  await setKeep(pev.page, false);
  await expect.poll(() => pev.main<number>('heldRecent')).toBe(1);
  const cleared = logCount(pev, 'recent.cleared', { proc: 'core', count: 1 });
  await coreExits(pev, written.pairs);
  await owesNothing(file, sourceKey);
  await expect
    .poll(() => logCount(pev, 'recent.cleared', { proc: 'core', count: 1 }))
    .toBe(cleared + 1);
  await expect(keepSwitch(pev.page)).not.toBeChecked();

  // Off then On, the wipe held, then core exits: the old entry stays gone,
  // and a search committed once On is in effect is recorded alone.
  await setKeep(pev.page, true);
  await backToMail(pev.page);
  await commit(pev, 'beta');
  await recorded(pev, ['beta']);
  await pev.main('holdRecent');
  await openIndexSettings(pev.page);
  await setKeep(pev.page, false);
  await expect.poll(() => pev.main<number>('heldRecent')).toBe(1);
  await setKeep(pev.page, true);
  await coreExits(pev, written.pairs);
  await owesNothing(file, sourceKey);
  await backToMail(pev.page);
  expect(await recentTexts(pev.page)).toEqual([]);
  await commit(pev, 'gamma');
  await recorded(pev, ['gamma']);

  // A Clear held in core, then core exits: it is refused as stale, and nothing was cleared.
  await pev.main('holdRecent');
  await openIndexSettings(pev.page);
  await clearButton(pev.page).dispatchEvent('click');
  await expect.poll(() => pev.main<number>('heldRecent')).toBe(1);
  await coreExits(pev, written.pairs);
  await expect(pev.page.locator('.settings-notice')).toHaveText('Export changed. Try again.');
  await backToMail(pev.page);
  await recorded(pev, ['gamma']);
  await checkHidden(pev);
});

test('Rebuild keeps the switch: off, no entries and nothing recorded; on, no entries and a new search recorded', async ({
  pev,
}) => {
  const written = chipExport(realpathSync(testDir('recent-rebuild')), 94);
  const stamp = await openExport(pev, written);
  await commit(pev, 'alpha');
  await recorded(pev, ['alpha']);
  const rebuild = async () => {
    const before = (await pev.main<Stamp>('sourceStamp')).generation;
    await pev.page
      .getByRole('button', { name: 'Rebuild index', exact: true })
      .dispatchEvent('click');
    await expect
      .poll(async () => (await pev.main<Stamp>('sourceStamp')).generation)
      .toBeGreaterThan(before);
    await phase1Done(pev, written.pairs);
  };

  await openIndexSettings(pev.page);
  await setKeep(pev.page, false);
  await rebuild();
  await expect(keepSwitch(pev.page)).not.toBeChecked();
  await backToMail(pev.page);
  await commit(pev, 'beta');
  await expect.poll(() => logCount(pev, 'recent.dropped', { reason: 'off' })).toBe(1);
  expect(await recentTexts(pev.page)).toEqual([]);

  await openIndexSettings(pev.page);
  await setKeep(pev.page, true);
  await backToMail(pev.page);
  await commit(pev, 'gamma');
  await recorded(pev, ['gamma']);
  await openIndexSettings(pev.page);
  await rebuild();
  await expect(keepSwitch(pev.page)).toBeChecked();
  await backToMail(pev.page);
  expect(await recentTexts(pev.page)).toEqual([]);
  await commit(pev, 'delta');
  await recorded(pev, ['delta']);
  expect((await pev.main<Stamp>('sourceStamp')).sourceKey).toBe(stamp.sourceKey);
  await checkHidden(pev);
});

test('an owed wipe that fails keeps the gate closed until the next activation pays it', async () => {
  const written = chipExport(realpathSync(testDir('recent-gate-failed')), 95);
  const first = await launch('recent-gate-failed');
  let dbPath: string;
  let sourceKey: string;
  let file: string;
  try {
    sourceKey = (await openExport(first, written)).sourceKey;
    dbPath = await dbPathOf(first);
    file = await first.main<string>('registryFile');
    await commit(first, 'alpha');
    await recorded(first, ['alpha']);

    await first.main('failRecentWipe');
    await openIndexSettings(first.page);
    await setKeep(first.page, false);
    await expect.poll(() => first.hasLog('recent.wipe_failed', { proc: 'main' })).toBe(true);
    await setKeep(first.page, true);
    expect(sourceRecord(file, sourceKey)).toMatchObject({
      keepRecentSearches: true,
      recentWipePending: true,
    });
    await backToMail(first.page);
    // Nothing from before the Off shows, and nothing new reaches core.
    const received = await first.main<number>('recentReceived');
    expect(await recentTexts(first.page)).toEqual([]);
    await openMenu(first);
    await first.page.waitForTimeout(300);
    await expect(first.page.locator('.recent-menu')).toHaveCount(0);
    await first.page.locator('.search-box').blur();
    await commit(first, 'beta');
    await expect.poll(() => logCount(first, 'recent.dropped', { reason: 'wipe_owed' })).toBe(1);
    expect(await first.main<number>('recentReceived')).toBe(received);
    expect(sourceRecord(file, sourceKey)?.recentWipePending).toBe(true);
    await checkHidden(first);
  } finally {
    await first.close();
  }
  // The failed wipe deleted nothing: the gate alone kept it hidden.
  expect(rowTexts(dbPath)).toEqual(['alpha']);

  const second = await launch('recent-gate-failed-2', { userData: first.userData });
  try {
    await phase1Done(second, written.pairs);
    await owesNothing(file, sourceKey);
    expect(await recentTexts(second.page)).toEqual([]);
    await commit(second, 'gamma');
    await recorded(second, ['gamma']);
  } finally {
    await second.close();
  }
  expect(rowTexts(dbPath)).toEqual(['gamma']);
});

test('two exports keep their own switch and entries; Off then On held, a switch away and back pays the wipe', async ({
  pev,
}) => {
  const root = realpathSync(testDir('recent-two'));
  const a = chipExport(root, 96, 'mail_20250630_120000');
  const b = chipExport(root, 96, 'mail_20250101_100000');
  const stampA = await openExport(pev, a);
  const file = await pev.main<string>('registryFile');
  // Each activation gives the runs new IDs, so they are read before every switch.
  const switchTo = async (runName: string, pairs: number) => {
    const runs = (await pev.main<SourcesView>('sourcesView')).active!.runs;
    const runId = runs.find((r) => r.runName === runName)!.runId;
    expect(await pev.shell('switchRun', [runId])).toMatchObject({ ok: true });
    await expect
      .poll(async () => (await pev.main<SourcesView>('sourcesView')).active?.runName)
      .toBe(runName);
    await phase1Done(pev, pairs);
  };

  await commit(pev, 'a-one');
  await recorded(pev, ['a-one']);
  await switchTo(b.runName, b.pairs);
  const stampB = await pev.main<Stamp>('sourceStamp');
  expect(stampB.sourceKey).not.toBe(stampA.sourceKey);
  expect(await recentTexts(pev.page)).toEqual([]);
  await commit(pev, 'b-one');
  await recorded(pev, ['b-one']);
  await openIndexSettings(pev.page);
  await setKeep(pev.page, false);
  await owesNothing(file, stampB.sourceKey);

  await switchTo(a.runName, a.pairs);
  await expect(keepSwitch(pev.page)).toBeChecked();
  await backToMail(pev.page);
  await recorded(pev, ['a-one']);

  // On A: Off then On with the wipe held; the switch to B drops it, and A's next activation pays it.
  await pev.main('holdRecent');
  await openIndexSettings(pev.page);
  await setKeep(pev.page, false);
  await expect.poll(() => pev.main<number>('heldRecent')).toBe(1);
  await setKeep(pev.page, true);
  await switchTo(b.runName, b.pairs);
  await expect(keepSwitch(pev.page)).not.toBeChecked();
  expect(sourceRecord(file, stampA.sourceKey)?.recentWipePending).toBe(true);
  await switchTo(a.runName, a.pairs);
  await owesNothing(file, stampA.sourceKey);
  await backToMail(pev.page);
  expect(await recentTexts(pev.page)).toEqual([]);
  await commit(pev, 'a-two');
  await recorded(pev, ['a-two']);
  expect(sourceRecord(file, stampB.sourceKey)).toMatchObject({ keepRecentSearches: false });
  await checkHidden(pev);
});

test('Off then On held, then the app closed: the relaunch pays the wipe, and a new search is recorded', async () => {
  const written = chipExport(realpathSync(testDir('recent-relaunch')), 97);
  const first = await launch('recent-relaunch');
  let file: string;
  let sourceKey: string;
  try {
    sourceKey = (await openExport(first, written)).sourceKey;
    file = await first.main<string>('registryFile');
    await commit(first, 'alpha');
    await recorded(first, ['alpha']);
    await first.main('holdRecent');
    await openIndexSettings(first.page);
    await setKeep(first.page, false);
    await expect.poll(() => first.main<number>('heldRecent')).toBe(1);
    await setKeep(first.page, true);
  } finally {
    await first.close();
  }
  expect(sourceRecord(file, sourceKey)).toMatchObject({
    keepRecentSearches: true,
    recentWipePending: true,
  });
  const second = await launch('recent-relaunch-2', { userData: first.userData });
  try {
    await phase1Done(second, written.pairs);
    await owesNothing(file, sourceKey);
    expect(await recentTexts(second.page)).toEqual([]);
    await commit(second, 'beta');
    await recorded(second, ['beta']);
  } finally {
    await second.close();
  }
});

test('an unavailable export keeps its recent searches: listed, recorded, cleared, and its switch holds', async () => {
  const root = realpathSync(testDir('recent-offline'));
  const written = chipExport(root, 98);
  const first = await launch('recent-offline');
  let dbPath: string;
  try {
    await openExport(first, written);
    dbPath = await dbPathOf(first);
    await commit(first, 'alpha');
    await commit(first, 'beta');
    await recorded(first, ['beta', 'alpha']);
  } finally {
    await first.close();
  }

  renameSync(join(root, written.account), join(root, 'moved-away'));
  const second = await launch('recent-offline-2', { userData: first.userData });
  try {
    await expect
      .poll(async () => (await second.main<SourcesView>('sourcesView')).active?.status)
      .toBe('offline');
    await recorded(second, ['beta', 'alpha']);
    // Searched from the index, and recorded there.
    await commit(second, 'budget');
    await recorded(second, ['budget', 'beta', 'alpha']);
    await openIndexSettings(second.page);
    await clearButton(second.page).dispatchEvent('click');
    await expect.poll(() => second.hasLog('recent.cleared', { proc: 'core', count: 3 })).toBe(true);
    await backToMail(second.page);
    expect(await recentTexts(second.page)).toEqual([]);
    await commit(second, 'lunch');
    await recorded(second, ['lunch']);
    await openIndexSettings(second.page);
    await setKeep(second.page, false);
    await expect.poll(() => second.hasLog('recent.cleared', { proc: 'core', count: 1 })).toBe(true);
  } finally {
    await second.close();
  }
  expect(rowTexts(dbPath)).toEqual([]);

  const third = await launch('recent-offline-3', { userData: first.userData });
  try {
    await expect
      .poll(async () => (await third.main<SourcesView>('sourcesView')).active?.status)
      .toBe('offline');
    await openIndexSettings(third.page);
    await expect(keepSwitch(third.page)).not.toBeChecked();
  } finally {
    await third.close();
  }
});

test('a stale export or generation is refused and changes nothing; Forget then adding the export again turns the switch on', async ({
  pev,
}) => {
  const root = realpathSync(testDir('recent-stale'));
  const a = chipExport(root, 99, 'mail_20250630_120000');
  const b = chipExport(root, 99, 'mail_20250101_100000');
  const stampA = await openExport(pev, a);
  const file = await pev.main<string>('registryFile');
  await commit(pev, 'alpha');
  await recorded(pev, ['alpha']);

  // What Settings showed for A, sent once B is open.
  const runs = (await pev.main<SourcesView>('sourcesView')).active!.runs;
  await pev.shell('switchRun', [runs.find((r) => r.runName === b.runName)!.runId]);
  await phase1Done(pev, b.pairs);
  const stampB = await pev.main<Stamp>('sourceStamp');
  const old = { sourceKey: stampA.sourceKey, generation: stampA.generation };
  expect(await invoke(pev.page, IPC.clearRecent, old)).toEqual({
    ok: false,
    code: 'stale_generation',
  });
  expect(await invoke(pev.page, IPC.keepRecent, { ...old, keep: false })).toEqual({
    ok: false,
    code: 'stale_generation',
  });
  // B's current generation with A's key, too.
  const mixed = { sourceKey: stampA.sourceKey, generation: stampB.generation };
  expect(await invoke(pev.page, IPC.keepRecent, { ...mixed, keep: false })).toEqual({
    ok: false,
    code: 'stale_generation',
  });
  expect(sourceRecord(file, stampA.sourceKey)?.keepRecentSearches).toBeUndefined();
  expect(sourceRecord(file, stampA.sourceKey)?.recentWipePending).toBeUndefined();
  await pev.shell('openExport', [stampA.sourceKey]);
  await phase1Done(pev, a.pairs);
  await recorded(pev, ['alpha']);

  // Forget, then the export added again: a new record, with the switch on.
  await openIndexSettings(pev.page);
  await setKeep(pev.page, false);
  // Settings stays open across a Forget and an open; back to the mail first.
  await backToMail(pev.page);
  const key = (await pev.main<Stamp>('sourceStamp')).sourceKey;
  expect(await pev.shell('forgetExport', [key])).toMatchObject({ ok: true, outcome: 'forgotten' });
  expect(sourceRecord(file, key)).toBeUndefined();
  await openExport(pev, a, 'bm2');
  await openIndexSettings(pev.page);
  await expect(keepSwitch(pev.page)).toBeChecked();
  await backToMail(pev.page);
  expect(await recentTexts(pev.page)).toEqual([]);
  await checkHidden(pev);
});

test('a registry written without the switch loads it on; a row that fails the check is never shown, and goes at the next recording', async () => {
  const written = chipExport(realpathSync(testDir('recent-older')), 100);
  const first = await launch('recent-older');
  let dbPath: string;
  let file: string;
  let sourceKey: string;
  try {
    sourceKey = (await openExport(first, written)).sourceKey;
    dbPath = await dbPathOf(first);
    file = await first.main<string>('registryFile');
    await commit(first, 'alpha');
    await recorded(first, ['alpha']);
  } finally {
    await first.close();
  }
  const record = sourceRecord(file, sourceKey)!;
  expect(Object.keys(record)).not.toContain('keepRecentSearches');
  expect(Object.keys(record)).not.toContain('recentWipePending');
  // Newer than the valid row: a broken JSON, an unknown version, and a chip of no kind.
  const valid = searchKey({ text: 'alpha', chips: [] });
  addIndexRows(dbPath, [
    { q: '{"v":1,"text":"broken"', at: Date.now() + 1000 },
    { q: valid.replace('"v":1', '"v":2'), at: Date.now() + 2000 },
    {
      q: searchKey({ text: 'kind', chips: [] }).replace('[]', '[{"k":"x"}]'),
      at: Date.now() + 3000,
    },
  ]);

  const second = await launch('recent-older-2', { userData: first.userData });
  try {
    await phase1Done(second, written.pairs);
    await openIndexSettings(second.page);
    await expect(keepSwitch(second.page)).toBeChecked();
    await backToMail(second.page);
    await recorded(second, ['alpha']);
    await expect
      .poll(() => second.hasLog('recent.invalid_rows', { proc: 'core', count: 3 }))
      .toBe(true);
    await commit(second, 'beta');
    await recorded(second, ['beta', 'alpha']);
  } finally {
    await second.close();
  }
  expect(rowTexts(dbPath)).toEqual(['beta', 'alpha']);
  expect(indexRows(dbPath)).toHaveLength(2);
  // No text of a row that failed the check reaches a log.
  expect(JSON.stringify(second.logs())).not.toContain('broken');
});

test('the shell commits nothing for an empty box with no chips', async ({ pev }) => {
  const written = chipExport(realpathSync(testDir('recent-empty')), 101);
  await openExport(pev, written);
  await keyInBox(pev.page, 'Enter');
  await typeText(pev.page, '   ');
  await keyInBox(pev.page, 'Enter');
  await pev.page.waitForTimeout(300);
  expect(await pev.main<number>('recentReceived')).toBe(0);
  expect(await searchState(pev)).toMatchObject({ active: false });
  await checkHidden(pev);
});
