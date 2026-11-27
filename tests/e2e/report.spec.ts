// SPDX-License-Identifier: AGPL-3.0-or-later
// The index report in the shell: opened from the list header once the export
// is loaded and from the loading line while it loads, its counts and rows for
// a generated export with files that need attention, "Copy report", and the
// checks on its channel.

import { readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { IndexProgress, IndexTotals } from '../../src/shared/index-types';
import { writeExport } from '../exports';
import { testDir } from '../paths';
import { expect, test, type PevApp } from './app';

type Answer<T> = { answer: T; progress: IndexProgress } | null;

async function progress(pev: PevApp): Promise<IndexProgress | undefined> {
  return (await pev.main<Answer<IndexTotals>>('indexQuery', { op: 'totals' }))?.progress;
}

/** The message open in the reader, and its view. */
const reader = (pev: PevApp) =>
  pev.shell<{ rowid: number | null; view: { url: string } | null }>('reader');

/** Hidden windows get no frames to click in: events are sent directly. */
const press = (page: Page, selector: string) => page.locator(selector).dispatchEvent('click');

const invoke = (pev: PevApp, channel: string, ...args: unknown[]) =>
  pev.page.evaluate(
    ([c, a]) =>
      (
        window as unknown as {
          __pevTestIpc: { invoke(c: string, ...x: unknown[]): Promise<unknown> };
        }
      ).__pevTestIpc.invoke(c, ...(a as unknown[])),
    [channel, args] as const,
  );

/** The text of each clipboard write; test builds record them instead. */
async function clipboardWrites(pev: PevApp): Promise<string[]> {
  const calls = await pev.main<Array<{ method: string; args: string[] }>>('externalCalls');
  return calls.filter((c) => c.method === 'clipboard.writeText').map((c) => c.args[0] ?? '');
}

test('the report lists the files that need attention, and copies them as text', async ({ pev }) => {
  const root = realpathSync(testDir('report-files'));
  const written = writeExport(root, { seed: 46, messages: 12 });
  const ids = readdirSync(written.run)
    .filter((n) => n.endsWith('.eml'))
    .map((n) => n.slice(0, -'.eml'.length))
    .sort();
  rmSync(join(written.run, `${ids[0]}.metadata.json`));
  rmSync(join(written.run, `${ids[1]}.eml`));
  writeFileSync(join(written.run, `${ids[2]}.metadata.json`), '{"Version": 1, "Payload": {');
  symlinkSync(join(written.run, `${ids[3]}.eml`), join(written.run, 'zz-link.metadata.json'));

  await pev.main('queuePick', root, 'bm1');
  await pev.shell('chooseFolder', []);
  await expect.poll(() => progress(pev), { timeout: 20_000 }).toMatchObject({ phase: 'done' });

  const link = pev.page.locator('.list-head .attention');
  await expect(link).toHaveText('4 files need attention');
  await press(pev.page, '.list-head .attention');

  const card = pev.page.locator('.ix-card');
  await expect(card.locator('h1')).toHaveText('Index report');
  await expect(card.locator('.phase h3 .pill')).toHaveText('Done');
  // 12 pairs, less the two whose metadata is missing or isn't JSON.
  await expect(card.locator('.ix-stats')).toContainText('10 messages');
  await expect(card.locator('.ix-stats')).toContainText('folders and labels');
  await expect(card.locator('.ix-stats')).toContainText(/took \d/);
  await expect(card.locator('.report h2')).toHaveText('4 files need attention');
  const rows = await card.locator('.report tbody tr').evaluateAll((trs) =>
    trs.map((tr) => {
      const td = [...tr.querySelectorAll('td')];
      return [td[0]!.textContent, td[1]!.getAttribute('title'), td[2]!.textContent];
    }),
  );
  expect(rows).toEqual([
    ['Skipped', 'zz-link.metadata.json', 'Symbolic link. Not read.'],
    ['Skipped', `${ids[2]}.metadata.json`, 'Invalid JSON. Not listed.'],
    ['Skipped', `${ids[0]}.eml`, 'Metadata missing. Not listed.'],
    ['Listed', `${ids[1]}.metadata.json`, 'Message file missing.'],
  ]);
  // Long names show their start and end; the whole name is the title.
  await expect(card.locator('.report tbody tr').nth(1).locator('.file')).toContainText('…');

  await press(pev.page, '.ix-foot button:text("Copy report")');
  await expect(card.locator('.ix-foot .note')).toHaveText('Report copied.');
  const copies = await clipboardWrites(pev);
  expect(copies).toHaveLength(1);
  const text = copies[0]!;
  expect(text).toContain('Messages: 10\n');
  expect(text).toContain('4 files need attention\n');
  expect(text).toContain('Skipped\tzz-link.metadata.json\tSymbolic link. Not read. (symlink)\n');
  expect(text).not.toContain(root);
  expect(text).not.toContain(written.account);
  expect(text).not.toContain(written.runName);
  await expect.poll(() => pev.hasLog('report.copied', { proc: 'main', count: 4 })).toBe(true);

  await press(pev.page, '.ix-foot button:text("Start browsing")');
  await expect(card).toHaveCount(0);
  await expect(pev.page.locator('.list-scroll')).toBeVisible();
});

test('the loading line opens the report while the export loads', async ({ pev }) => {
  const root = realpathSync(testDir('report-loading'));
  const written = writeExport(root, { seed: 47, messages: 40 });
  await pev.main('indexTestSettings', { batchPairs: 10, holdWrites: true });
  await pev.main('queuePick', root, 'bm1');
  await pev.shell('chooseFolder', []);
  await expect.poll(() => pev.main<number>('heldWrites')).toBeGreaterThan(0);
  await pev.main('releaseWrites', 1);
  await expect.poll(async () => (await progress(pev))?.loaded).toBe(10);
  // Nothing needs attention, so the header names nothing.
  await expect(pev.page.locator('.list-head .attention')).toHaveCount(0);
  // A message open in the reader.
  await press(pev.page, '.list-scroll .conv >> nth=0');
  await expect.poll(async () => (await reader(pev)).view?.url ?? null).not.toBeNull();
  const shown = await reader(pev);
  const loads = async () => {
    const { body } = await pev.main<{ body: string[] }>('requests', 1);
    return body.filter((u) => u === shown.view!.url).length;
  };
  await expect.poll(loads).toBeGreaterThan(0);
  const loaded = await loads();

  await press(pev.page, '.side-foot .loading-text');
  const card = pev.page.locator('.ix-card');
  await expect(card.locator('h1')).toHaveText('Indexing');
  await expect(card.locator('.phase h3 .pill')).toHaveText('25%');
  await expect(card.locator('.ix-stats')).toContainText(`Loading 10 of ${written.pairs}…`);
  await expect(card.locator('.progress')).toHaveAttribute('aria-valuenow', '10');
  await expect(card.locator('.report')).toHaveCount(0);

  await pev.main('releaseWrites', null);
  await expect.poll(() => progress(pev), { timeout: 20_000 }).toMatchObject({ phase: 'done' });
  await expect(card.locator('h1')).toHaveText('Index report');
  await expect(card.locator('.phase h3 .pill')).toHaveText('Done');
  await expect(card.locator('.ix-stats')).toContainText(`${written.pairs} messages`);
  await expect(card.locator('.progress')).toHaveCount(0);
  await press(pev.page, '.ix-foot button:text("Start browsing")');
  await expect(card).toHaveCount(0);
  await expect(pev.page.locator('.list-head .attention')).toHaveCount(0);
  // The mail stayed as it was under the report: the same message and its
  // frame, with the body not loaded again.
  expect(await reader(pev)).toMatchObject({ rowid: shown.rowid, view: { url: shown.view!.url } });
  await expect(pev.page.locator('.reader iframe.rp-frame')).toHaveAttribute('src', shown.view!.url);
  await pev.page.waitForTimeout(300);
  expect(await loads()).toBe(loaded);
});

test('the report channels check their arguments and the generation', async ({ pev }) => {
  const root = realpathSync(testDir('report-channel'));
  writeExport(root, { seed: 48, messages: 6 });
  await pev.main('queuePick', root, 'bm1');
  await pev.shell('chooseFolder', []);
  await expect.poll(() => progress(pev), { timeout: 20_000 }).toMatchObject({ phase: 'done' });
  const generation = (await pev.shell<{ generation: number }>('state')).generation;

  expect(await invoke(pev, 'pev:index', { query: { op: 'report' }, generation })).toMatchObject({
    ok: true,
    generation,
    answer: { messages: 6, attention: 0, rows: [] },
  });
  expect(
    await invoke(pev, 'pev:index', { query: { op: 'report', all: true }, generation }),
  ).toEqual({ ok: false, code: 'invalid' });

  expect(await invoke(pev, 'pev:copy-report', { generation })).toEqual({ ok: true, generation });
  for (const bad of [[], [{}], [{ generation, text: 'x' }], [{ generation }, 'extra'], ['x']]) {
    expect(await invoke(pev, 'pev:copy-report', ...bad), JSON.stringify(bad)).toEqual({
      ok: false,
      code: 'invalid',
    });
  }
  expect(await invoke(pev, 'pev:copy-report', { generation: generation + 1 })).toEqual({
    ok: false,
    code: 'stale_generation',
  });
  // Only the valid call reached the clipboard.
  expect(await clipboardWrites(pev)).toHaveLength(1);
});
